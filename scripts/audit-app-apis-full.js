#!/usr/bin/env node
/**
 * Customer + staff app API response audit — compare JSON fields to MongoDB.
 * Usage: node scripts/audit-app-apis-full.js [--tenant KAIRALI] [--customer 9847234567]
 */
import { randomUUID } from "node:crypto";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  Branch,
  Customer,
  LedgerEntry,
  Message,
  Payment,
  Scheme,
  Tenant,
  User,
} from "../src/models/index.js";
import { MessageType, PAYMENT_MODE_ORDER } from "../src/constants/enums.js";
import { Permission, ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { resolveQueryDateRange } from "../src/lib/query-filters.js";
import { cashBalance } from "../src/services/cash.service.js";
import { attachLedgerTotals } from "../src/services/scheme.service.js";

const BASE = process.env.API_BASE ?? "http://localhost:4000/api/v1";

const issues = [];
const passes = [];
let tenantId = null;

function pass(msg) {
  passes.push(msg);
  console.log(`✓ ${msg}`);
}
function fail(area, msg, ctx) {
  const line = ctx ? `${area}: ${msg} (${ctx})` : `${area}: ${msg}`;
  issues.push(line);
  console.error(`✗ ${line}`);
}

function parseArgs(argv) {
  const args = {
    tenantCode: "KAIRALI",
    password: "2026",
    customerMobile: "9847234567",
    staffMobile: "9847012350",
    collectorMobile: "9847012352",
  };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--tenant") args.tenantCode = argv[++i];
    else if (argv[i] === "--password") args.password = argv[++i];
    else if (argv[i] === "--customer") args.customerMobile = argv[++i];
    else if (argv[i] === "--staff") args.staffMobile = argv[++i];
    else if (argv[i] === "--collector") args.collectorMobile = argv[++i];
  }
  return args;
}

function idOf(row) {
  return String(row?.id ?? row?._id ?? "");
}

function paiseOf(ref) {
  if (ref == null) return null;
  if (typeof ref === "number") return ref;
  return ref.amountPaise ?? null;
}

function mobileSuffix(m) {
  return String(m ?? "").replace(/\D/g, "").slice(-10);
}

function assertEq(area, field, apiVal, dbVal, ctx) {
  const norm = (v) => (v == null ? null : typeof v === "number" ? v : String(v));
  if (norm(apiVal) !== norm(dbVal)) {
    fail(area, `${field} API=${JSON.stringify(apiVal)} DB=${JSON.stringify(dbVal)}`, ctx);
    return false;
  }
  pass(`${ctx} ${field} matches DB`);
  return true;
}

async function api(token, method, path, { query = {}, body, idempotency = false } = {}) {
  const params = new URLSearchParams(query);
  const qs = params.toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ""}`;
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idempotency) headers["x-idempotency-key"] = randomUUID();
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let parsed;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { ok: res.ok, status: res.status, body: parsed, url };
}

function dataOf(res) {
  return res.body?.data ?? res.body;
}

function listItems(res) {
  const d = dataOf(res);
  if (Array.isArray(d)) return d;
  return d?.rows ?? d?.items ?? d?.data ?? [];
}

async function staffLogin(tenantCode, mobile, password) {
  const res = await api(null, "POST", "/auth/login", {
    body: { tenantCode, mobile, password, deviceId: "audit-app-apis", platform: "web" },
  });
  const data = dataOf(res);
  if (!res.ok) throw new Error(`Staff login failed (${mobile}): ${JSON.stringify(res.body)}`);
  tenantId = data.user?.tenantId ?? tenantId;
  return { token: data.accessToken, user: data.user };
}

async function customerLogin(tenantCode, mobile) {
  const otpRes = await api(null, "POST", "/public/auth/otp/request", {
    body: { tenantCode, mobile, purpose: "LOGIN", deviceId: "audit-app-apis" },
    idempotency: true,
  });
  const otpData = dataOf(otpRes);
  if (!otpRes.ok) throw new Error(`OTP request failed: ${JSON.stringify(otpRes.body)}`);
  const verifyRes = await api(null, "POST", "/public/auth/otp/verify", {
    body: {
      tenantCode,
      mobile,
      purpose: "LOGIN",
      deviceId: "audit-app-apis",
      otp: "123456",
      otpId: otpData.otpId,
    },
    idempotency: true,
  });
  const data = dataOf(verifyRes);
  if (!verifyRes.ok) throw new Error(`Customer OTP verify failed: ${JSON.stringify(verifyRes.body)}`);
  tenantId = tenantId ?? (await Customer.findById(data.customer?.id).select("tenantId").lean())?.tenantId;
  return { token: data.accessToken, customerId: data.customer?.id };
}

function rolePermissions(role) {
  const list = ROLE_PERMISSIONS[role];
  if (!list) return new Set();
  if (list.includes("*")) return new Set(Object.values(Permission));
  return new Set(list);
}

function hasPermission(user, permission) {
  const fromRole = rolePermissions(user.role);
  if (fromRole.has(permission)) return true;
  const explicit = user.permissions ?? [];
  return explicit.includes("*") || explicit.includes(permission);
}

async function dbLifetimePaid(customerId) {
  const ledgers = await LedgerEntry.find({ tenantId, customerId }).lean();
  return ledgers
    .filter((row) => ["INSTALLMENT_PAYMENT", "FREE_WINDOW_PAYMENT"].includes(row.type))
    .reduce((sum, row) => sum + row.amountPaise, 0);
}

async function dbPaymentStats(customerId) {
  const rows = await Payment.find({ tenantId, customerId, status: "SUCCESS" }).lean();
  return {
    count: rows.length,
    amountPaise: rows.reduce((s, r) => s + r.amountPaise, 0),
  };
}

async function dbSchemePaidPaise(schemeId) {
  const [withTotals] = await attachLedgerTotals(tenantId, [
    await Scheme.findById(schemeId).lean(),
  ]);
  return withTotals?.totals?.amountPaidPaise ?? 0;
}

function dbInstallmentsFullyPaid(scheme) {
  return (scheme.installments ?? []).filter((r) => ["PAID", "WAIVED"].includes(r.status)).length;
}

async function expectedCollectionSummary(scope, from, to) {
  const match = {
    tenantId,
    status: "SUCCESS",
    paidAt: {
      $gte: new Date(`${from}T00:00:00+05:30`),
      $lte: new Date(`${to}T23:59:59.999+05:30`),
    },
    ...scope,
  };
  const [totals, modes] = await Promise.all([
    Payment.aggregate([
      { $match: match },
      { $group: { _id: null, amountPaise: { $sum: "$amountPaise" }, count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      { $match: match },
      { $group: { _id: "$mode", amountPaise: { $sum: "$amountPaise" }, count: { $sum: 1 } } },
    ]),
  ]);
  const modeMap = new Map(modes.map((r) => [r._id, r]));
  const byMode = PAYMENT_MODE_ORDER.filter(
    (mode) => mode !== "LEGACY_ONLINE" || modes.some((r) => r._id === mode),
  ).map((mode) => {
    const row = modeMap.get(mode);
    return { mode, amountPaise: row?.amountPaise ?? 0, count: row?.count ?? 0 };
  });
  return {
    amountPaise: totals[0]?.amountPaise ?? 0,
    count: totals[0]?.count ?? 0,
    byMode,
  };
}

async function auditCustomerResponses(token, customerId, label, tenantRow = null) {
  const dbCustomer = await Customer.findOne({ _id: customerId, tenantId }).lean();
  if (!dbCustomer) throw new Error(`Customer ${customerId} not in DB`);

  const profileRes = await api(token, "GET", "/app/profile");
  if (!profileRes.ok) {
    fail("Customer profile", `HTTP ${profileRes.status}`, label);
    return;
  }
  const profile = dataOf(profileRes);
  assertEq("Profile", "id", profile.id, dbCustomer._id, label);
  assertEq("Profile", "name", profile.name, dbCustomer.name, label);
  assertEq("Profile", "customerNumber", profile.customerNumber, dbCustomer.customerNumber, label);
  assertEq("Profile", "passbookNumber", profile.passbookNumber, dbCustomer.passbookNumber ?? null, label);
  assertEq("Profile", "status", profile.status, dbCustomer.status, label);
  const kycMandatory = Boolean(tenantRow?.settings?.requireKycForEnrolment);
  if (kycMandatory) {
    assertEq("Profile", "kyc.status", profile.kyc?.status, dbCustomer.kyc?.status ?? "NOT_SUBMITTED", label);
  } else if (profile.kyc != null) {
    fail("Profile", "kyc should be omitted when KYC is not mandatory", label);
  } else {
    pass(`${label} profile omits kyc (requireKycForEnrolment=false)`);
  }
  if (mobileSuffix(profile.mobile) !== mobileSuffix(dbCustomer.mobile)) {
    fail("Profile", `mobile API=${profile.mobile} DB=${dbCustomer.mobile}`, label);
  } else pass(`${label} profile.mobile matches DB`);
  if (dbCustomer.branchId) {
    const branch = await Branch.findById(dbCustomer.branchId).lean();
    assertEq("Profile", "branch.id", profile.branch?.id, branch?._id, label);
    assertEq("Profile", "branch.code", profile.branch?.code, branch?.code, label);
  }

  const home = dataOf(await api(token, "GET", "/app/home"));
  if (home) {
    assertEq("Home", "customer.id", home.customer?.id, dbCustomer._id, label);
    assertEq("Home", "customer.name", home.customer?.name, dbCustomer.name, label);
    assertEq("Home", "customer.passbookNumber", home.customer?.passbookNumber, dbCustomer.passbookNumber ?? null, label);

    const dbActive = await Scheme.countDocuments({
      tenantId,
      customerId,
      status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED", "MATURED"] },
    });
    assertEq("Home", "summary.activeSchemeCount", home.summary?.activeSchemeCount, dbActive, label);

    const payStats = await dbPaymentStats(customerId);
    assertEq("Home", "summary.totalPaid.amountPaise", paiseOf(home.summary?.totalPaid), payStats.amountPaise, label);

    for (const card of home.activeSchemes ?? []) {
      const scheme = await Scheme.findById(card.id).lean();
      if (!scheme) {
        fail("Home scheme card", `unknown scheme ${card.id}`, label);
        continue;
      }
      assertEq("Home scheme", "schemeNumber", card.schemeNumber, scheme.enrollmentNumber, `${label}/${card.schemeNumber}`);
      assertEq("Home scheme", "status", card.status, scheme.status, `${label}/${card.schemeNumber}`);
      assertEq("Home scheme", "planName", card.planName, scheme.planSnapshot?.displayName ?? scheme.planSnapshot?.name, `${label}/${card.schemeNumber}`);
      const dbPaid = await dbSchemePaidPaise(scheme._id);
      assertEq("Home scheme", "totalPaid.amountPaise", paiseOf(card.totalPaid), dbPaid, `${label}/${card.schemeNumber}`);
      const paidInst = dbInstallmentsFullyPaid(scheme);
      const labelMatch = String(card.progressLabel ?? "").match(/^(\d+) of (\d+)/);
      if (labelMatch) {
        assertEq("Home scheme", "progressLabel paid count", Number(labelMatch[1]), paidInst, `${label}/${card.schemeNumber}`);
      }
      for (const rp of card.recentPayments ?? []) {
        const dbPay = await Payment.findById(rp.id).lean();
        if (!dbPay) {
          fail("Home recent payment", `missing ${rp.id}`, label);
          continue;
        }
        assertEq("Home recent payment", "amountPaise", paiseOf(rp.amount), dbPay.amountPaise, `${label}/${rp.receiptNumber}`);
        assertEq("Home recent payment", "receiptNumber", rp.receiptNumber, dbPay.receiptNumber, `${label}/${rp.receiptNumber}`);
      }
    }
  }

  const paymentsRes = await api(token, "GET", "/app/payments", { query: { limit: "100" } });
  if (paymentsRes.ok) {
    const items = listItems(paymentsRes);
    const payStats = await dbPaymentStats(customerId);
    const summary = dataOf(paymentsRes)?.meta?.summary;
    if (summary) {
      assertEq("Payments meta", "totalPaidPaise", summary.totalPaidPaise, payStats.amountPaise, label);
      assertEq("Payments meta", "successCount", summary.successCount, payStats.count, label);
    }
    for (const row of items) {
      const dbPay = await Payment.findById(row.id).lean();
      if (!dbPay) {
        fail("Payment row", `missing ${row.id}`, label);
        continue;
      }
      assertEq("Payment row", "amountPaise", paiseOf(row.amount), dbPay.amountPaise, `${label}/${row.receiptNumber}`);
      assertEq("Payment row", "status", row.status, dbPay.status, `${label}/${row.receiptNumber}`);
      assertEq("Payment row", "receiptNumber", row.receiptNumber, dbPay.receiptNumber, `${label}/${row.receiptNumber}`);
      assertEq("Payment row", "schemeId", row.schemeId, dbPay.schemeId, `${label}/${row.receiptNumber}`);
      if (String(dbPay.customerId) !== String(customerId)) {
        fail("Payment row", "belongs to another customer", `${label}/${row.id}`);
      }
      const detail = await api(token, "GET", `/app/payments/${row.id}`);
      if (detail.ok) {
        const d = dataOf(detail);
        assertEq("Payment detail", "amountPaise", paiseOf(d.amount), dbPay.amountPaise, `${label}/${row.receiptNumber}`);
      } else {
        fail("Payment detail", `GET /app/payments/${row.id} HTTP ${detail.status}`, label);
      }
    }
  }

  const schemesRes = await api(token, "GET", "/app/schemes", { query: { limit: "50" } });
  if (schemesRes.ok) {
    for (const row of listItems(schemesRes)) {
      const scheme = await Scheme.findById(row.id).lean();
      if (!scheme) {
        fail("Scheme row", `missing ${row.id}`, label);
        continue;
      }
      assertEq("Scheme row", "schemeNumber", row.schemeNumber, scheme.enrollmentNumber, `${label}/${row.schemeNumber}`);
      assertEq("Scheme row", "status", row.status, scheme.status, `${label}/${row.schemeNumber}`);
      const dbPaid = await dbSchemePaidPaise(scheme._id);
      assertEq("Scheme row", "totalPaid.amountPaise", paiseOf(row.totalPaid), dbPaid, `${label}/${row.schemeNumber}`);

      const detail = dataOf(await api(token, "GET", `/app/schemes/${row.id}`));
      if (detail) {
        assertEq("Scheme detail", "id", detail.id ?? detail.scheme?.id, scheme._id, `${label}/${row.schemeNumber}`);
      }
      const passbook = dataOf(await api(token, "GET", `/app/schemes/${row.id}/passbook`));
      if (passbook?.totals?.paid) {
        assertEq("Scheme passbook", "totals.paid.amountPaise", paiseOf(passbook.totals.paid), dbPaid, `${label}/${row.schemeNumber}`);
      }
    }
  }

  const notif = dataOf(await api(token, "GET", "/app/notifications"));
  if (notif) {
    const dbUnread = await Message.countDocuments({ tenantId, customerId, readAt: null });
    assertEq("Notifications", "unreadCount", notif.unreadCount, dbUnread, label);
    for (const item of notif.items ?? []) {
      const dbMsg = await Message.findById(item.id ?? item._id).lean();
      if (!dbMsg) {
        fail("Notification row", `missing ${item.id}`, label);
        continue;
      }
      assertEq("Notification row", "customerId", dbMsg.customerId, customerId, `${label}/${idOf(item)}`);
      if (item.read != null) {
        const expectedRead = Boolean(dbMsg.readAt);
        assertEq("Notification row", "read", item.read, expectedRead, `${label}/${idOf(item)}`);
      }
    }
  }
}

async function auditStaffResponses(token, user, label) {
  const branchId = user.branchId;
  const staffId = user.id ?? user._id;
  const monthRange = resolveQueryDateRange({ period: "THIS_MONTH" });
  const { from, to } = monthRange;

  const profile = dataOf(await api(token, "GET", "/staff/profile"));
  const dbUser = await User.findById(staffId).lean();
  if (profile && dbUser) {
    assertEq("Staff profile", "id", profile.id ?? profile._id, dbUser._id, label);
    assertEq("Staff profile", "name", profile.name, dbUser.name, label);
    assertEq("Staff profile", "role", profile.role, dbUser.role, label);
    assertEq("Staff profile", "branchId", profile.branchId, dbUser.branchId, label);
  }

  const cash = dataOf(await api(token, "GET", "/staff/cash/summary"));
  if (cash) {
    const dbBal = await cashBalance({ tenantId, branchId, staffId });
    for (const field of [
      "cashCollectedPaise",
      "cashInHandPaise",
      "cashPendingAcceptancePaise",
      "collectedPaise",
      "handedOverPaise",
      "adjustmentPaise",
    ]) {
      if (cash[field] != null) assertEq("Cash summary", field, cash[field], dbBal[field], label);
    }
  }

  const collScope =
    user.role === "COLLECTION_AGENT"
      ? { collectedBy: staffId }
      : branchId
        ? await (async () => {
            const customerIds = await Customer.find({ tenantId, branchId }).distinct("_id");
            return {
              $or: [
                { branchId },
                { branchId: null, customerId: { $in: customerIds } },
                { branchId: { $exists: false }, customerId: { $in: customerIds } },
              ],
            };
          })()
        : {};

  const coll = dataOf(await api(token, "GET", "/staff/collections/summary", { query: { from, to } }));
  if (coll) {
    const expected = await expectedCollectionSummary(collScope, from, to);
    assertEq("Collection summary", "amountPaise", coll.amountPaise, expected.amountPaise, label);
    assertEq("Collection summary", "count", coll.count, expected.count, label);
    for (const modeRow of coll.byMode ?? []) {
      const dbMode = expected.byMode.find((r) => r.mode === modeRow.mode);
      if (!dbMode) {
        fail("Collection summary", `unknown mode ${modeRow.mode}`, label);
        continue;
      }
      assertEq("Collection byMode", `${modeRow.mode}.amountPaise`, modeRow.amountPaise, dbMode.amountPaise, label);
      assertEq("Collection byMode", `${modeRow.mode}.count`, modeRow.count, dbMode.count, label);
    }
  }

  const home = dataOf(await api(token, "GET", "/staff/home"));
  if (home) {
    const customerScope = branchId ? { tenantId, branchId } : { tenantId };
    assertEq("Staff home", "customers", home.customers, await Customer.countDocuments(customerScope), label);
    assertEq(
      "Staff home",
      "activeSchemes",
      home.activeSchemes,
      await Scheme.countDocuments({ ...customerScope, status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED"] } }),
      label,
    );
    if (home.today && coll) {
      assertEq("Staff home", "today.amountPaise", home.today.amountPaise, coll.amountPaise, label);
      assertEq("Staff home", "today.count", home.today.count, coll.count, label);
    }
  }

  const customersRes = await api(token, "GET", "/staff/customers", { query: { limit: "5" } });
  if (customersRes.ok) {
    for (const row of listItems(customersRes)) {
      const cid = idOf(row);
      const ctx = `${label}/customer ${row.name ?? cid}`;
      const dbCustomer = await Customer.findOne({ _id: cid, tenantId }).lean();
      if (!dbCustomer) {
        fail("Staff customer list", `missing ${cid}`, label);
        continue;
      }
      assertEq("Staff customer list", "name", row.name, dbCustomer.name, ctx);
      assertEq("Staff customer list", "branchId", row.branchId, dbCustomer.branchId, ctx);

      const detailRes = await api(token, "GET", `/staff/customers/${cid}`);
      if (!detailRes.ok) {
        fail("Staff customer detail", `HTTP ${detailRes.status}`, ctx);
        continue;
      }
      const detail = dataOf(detailRes);
      assertEq("Staff customer detail", "name", detail.name, dbCustomer.name, ctx);
      assertEq("Staff customer detail", "email", detail.email ?? null, dbCustomer.email ?? null, ctx);

      const lifetime = await dbLifetimePaid(cid);
      const payStats = await dbPaymentStats(cid);
      if (detail.summary) {
        assertEq("Staff customer detail", "summary.lifetimePaidPaise", detail.summary.lifetimePaidPaise, lifetime, ctx);
        assertEq("Staff customer detail", "summary.paymentCount", detail.summary.paymentCount, payStats.count, ctx);
      }

      for (const activeScheme of detail.activeSchemes ?? row.activeSchemes ?? []) {
        const sid = idOf(activeScheme);
        const scheme = await Scheme.findById(sid).lean();
        if (!scheme) {
          fail("Staff active scheme", `missing ${sid}`, ctx);
          continue;
        }
        assertEq("Staff active scheme", "enrollmentNumber", activeScheme.enrollmentNumber, scheme.enrollmentNumber, `${ctx}/${scheme.enrollmentNumber}`);
        assertEq("Staff active scheme", "status", activeScheme.status, scheme.status, `${ctx}/${scheme.enrollmentNumber}`);
        assertEq(
          "Staff active scheme",
          "installmentAmountPaise",
          activeScheme.installmentAmountPaise,
          scheme.installmentAmountPaise,
          `${ctx}/${scheme.enrollmentNumber}`,
        );
        const dbPaid = await dbSchemePaidPaise(sid);
        if (activeScheme.totalPaidPaise != null) {
          assertEq("Staff active scheme", "totalPaidPaise", activeScheme.totalPaidPaise, dbPaid, `${ctx}/${scheme.enrollmentNumber}`);
        }
      }
    }
  }

  const paymentsRes = await api(token, "GET", "/staff/payments", { query: { limit: "10" } });
  if (paymentsRes.ok) {
    for (const row of listItems(paymentsRes)) {
      const pid = idOf(row);
      const dbPay = await Payment.findById(pid).lean();
      if (!dbPay) {
        fail("Staff payment row", `missing ${pid}`, label);
        continue;
      }
      const ctx = `${label}/${dbPay.receiptNumber}`;
      assertEq("Staff payment", "amountPaise", row.amountPaise ?? paiseOf(row.amount), dbPay.amountPaise, ctx);
      assertEq("Staff payment", "status", row.status, dbPay.status, ctx);
      assertEq("Staff payment", "mode", row.mode, dbPay.mode, ctx);
      assertEq("Staff payment", "receiptNumber", row.receiptNumber, dbPay.receiptNumber, ctx);
      if (user.role === "COLLECTION_AGENT") {
        assertEq("Staff payment", "collectedBy", idOf(row.collectedBy), staffId, ctx);
      }
      if (row.customer) {
        const cust = await Customer.findById(dbPay.customerId).lean();
        assertEq("Staff payment", "customer.name", row.customer.name, cust?.name, ctx);
        assertEq("Staff payment", "customer.mobile", mobileSuffix(row.customer.mobile), mobileSuffix(cust?.mobile), ctx);
      }
      if (row.scheme) {
        const scheme = await Scheme.findById(dbPay.schemeId).lean();
        assertEq("Staff payment", "scheme.enrollmentNumber", row.scheme.enrollmentNumber, scheme?.enrollmentNumber, ctx);
      }
      if (row.weightMg != null && dbPay.weightMg != null) {
        assertEq("Staff payment", "weightMg", row.weightMg, dbPay.weightMg, ctx);
      }

      const detail = await api(token, "GET", `/staff/payments/${pid}`);
      if (detail.ok) {
        const d = dataOf(detail);
        assertEq("Staff payment detail", "amountPaise", d.amountPaise ?? paiseOf(d.amount), dbPay.amountPaise, ctx);
      }
    }
  }

  if (hasPermission(user, Permission.GOLD_RATE_READ)) {
    const rateRes = await api(token, "GET", "/staff/gold-rate/current");
    if (rateRes.ok) {
      const rate = dataOf(rateRes);
      const { currentGoldRate } = await import("../src/services/tenant.service.js");
      const { today } = await import("../src/lib/date.js");
      const dbRate = await currentGoldRate({ tenantId, branchId }, today());
      if (rate?.ratePerGramPaise != null && dbRate?.ratePerGramPaise != null) {
        assertEq("Staff gold rate", "ratePerGramPaise", rate.ratePerGramPaise, dbRate.ratePerGramPaise, label);
      }
    }
  }

  void MessageType;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`App API response audit @ ${BASE} (tenant ${args.tenantCode})\n`);

  await connectDatabase();
  try {
    const tenantRow = await Tenant.findOne({ code: args.tenantCode }).lean();
    if (tenantRow) tenantId = tenantRow._id;

    console.log("--- Customer app (response vs DB) ---");
    const { token: customerToken, customerId } = await customerLogin(args.tenantCode, args.customerMobile);
    await auditCustomerResponses(customerToken, customerId, `Customer ${args.customerMobile}`, tenantRow);

    console.log("\n--- Staff app (response vs DB) ---");
    const { token: staffToken, user: staffUser } = await staffLogin(args.tenantCode, args.staffMobile, args.password);
    await auditStaffResponses(staffToken, staffUser, `Staff ${args.staffMobile}`);

    console.log("\n--- Collector app (response vs DB) ---");
    const { token: collectorToken, user: collectorUser } = await staffLogin(
      args.tenantCode,
      args.collectorMobile,
      args.password,
    );
    await auditStaffResponses(collectorToken, collectorUser, `Collector ${args.collectorMobile}`);

    console.log(`\n--- Summary: ${passes.length} field checks passed, ${issues.length} mismatches ---`);
    if (issues.length) {
      console.error("\nMismatches:");
      for (const issue of issues) console.error(`  • ${issue}`);
      process.exitCode = 1;
    } else {
      console.log("\nAll API responses match database.");
    }
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
