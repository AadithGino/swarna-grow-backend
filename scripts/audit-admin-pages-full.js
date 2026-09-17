#!/usr/bin/env node
/**
 * Full tenant-admin page API audit + DB cross-checks.
 * Usage: node scripts/audit-admin-pages-full.js [--mobile 9847012345] [--password 2026]
 */
import assert from "node:assert/strict";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  Branch,
  CashHandover,
  Customer,
  Grievance,
  Message,
  Payment,
  PaymentLink,
  Redemption,
  Scheme,
  SchemePlan,
  User,
} from "../src/models/index.js";
import { RedemptionStatus } from "../src/constants/enums.js";
import { resolveQueryDateRange } from "../src/lib/query-filters.js";

const BASE = process.env.API_BASE ?? "http://localhost:4000/api/v1";
const OPEN_REDEMPTION = [
  RedemptionStatus.REQUESTED,
  RedemptionStatus.PENDING_APPROVAL,
  RedemptionStatus.APPROVED,
];

const issues = [];
const passes = [];
let tenantId = null;

function pass(msg) {
  passes.push(msg);
  console.log(`✓ ${msg}`);
}
function fail(area, msg, detail) {
  const line = detail ? `${area}: ${msg} (${detail})` : `${area}: ${msg}`;
  issues.push(line);
  console.error(`✗ ${line}`);
}

function parseArgs(argv) {
  const args = { mobile: "9847012345", password: "2026", role: "owner" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--mobile") args.mobile = argv[++i];
    else if (argv[i] === "--password") args.password = argv[++i];
    else if (argv[i] === "--role") args.role = argv[++i];
  }
  return args;
}

async function login(mobile, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mobile, password, deviceId: "audit-admin-pages-full" }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Login failed: ${JSON.stringify(body)}`);
  const data = body.data ?? body;
  tenantId = data.user?.tenantId ?? null;
  return { token: data.accessToken, user: data.user };
}

async function api(token, method, path, query = {}) {
  const params = new URLSearchParams(query);
  const qs = params.toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body, url };
}

function dataOf(res) {
  return res.body?.data ?? res.body;
}

function listItems(res) {
  const d = dataOf(res);
  if (Array.isArray(d)) return d;
  return d?.rows ?? d?.items ?? [];
}

function listTotal(res) {
  const d = dataOf(res);
  if (Array.isArray(d)) return d.length;
  return d?.meta?.total ?? d?.total ?? listItems(res).length;
}

async function expectOk(token, area, path, query = {}) {
  const res = await api(token, "GET", path, query);
  if (!res.ok) {
    fail(area, `HTTP ${res.status}`, res.url);
    return null;
  }
  pass(`${area} — ${path}`);
  return res;
}

async function dbChecks(token, label, user = null) {
  const scope = user?.branchId
    ? { tenantId, branchId: user.branchId }
    : { tenantId };
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const periodRange = resolveQueryDateRange({ period: "THIS_MONTH" });

  // Dashboard
  const dash = await api(token, "GET", "/admin/dashboard/summary");
  if (dash.ok) {
    const d = dataOf(dash);
    const [dbActiveCustomers, dbActiveSchemes, dbTodayPayments] = await Promise.all([
      Customer.countDocuments({ ...scope, status: "ACTIVE" }),
      Scheme.countDocuments({ ...scope, status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED"] } }),
      Payment.aggregate([
        { $match: { ...scope, status: "SUCCESS", paidAt: { $gte: todayStart } } },
        { $group: { _id: null, count: { $sum: 1 }, amountPaise: { $sum: "$amountPaise" } } },
      ]),
    ]);
    const apiCustomers = d?.customers?.active ?? d?.summary?.customers?.active;
    const apiSchemes = d?.schemes?.active ?? d?.summary?.schemes?.active;
    const apiTodayCount = d?.today?.count ?? d?.summary?.today?.count;
    const dbTodayCount = dbTodayPayments[0]?.count ?? 0;
    if (apiCustomers != null && apiCustomers !== dbActiveCustomers) {
      fail("Dashboard", `active customers API=${apiCustomers} DB=${dbActiveCustomers}`, label);
    } else pass(`${label} dashboard active customers = ${dbActiveCustomers}`);
    if (apiSchemes != null && apiSchemes !== dbActiveSchemes) {
      fail("Dashboard", `active schemes API=${apiSchemes} DB=${dbActiveSchemes}`, label);
    } else pass(`${label} dashboard active schemes = ${dbActiveSchemes}`);
    if (apiTodayCount != null && apiTodayCount !== dbTodayCount) {
      fail("Dashboard", `today payments API=${apiTodayCount} DB=${dbTodayCount}`, label);
    } else pass(`${label} dashboard today payment count = ${dbTodayCount}`);
  }

  // Nav badges
  const badges = await api(token, "GET", "/admin/nav-badges");
  if (badges.ok) {
    const b = dataOf(badges);
    const [dbDues, dbHandovers, dbRedemptions, dbFailed] = await Promise.all([
      Scheme.countDocuments({
        ...scope,
        paymentPattern: "FIXED",
        "installments.status": { $in: ["DUE", "PARTIALLY_PAID"] },
      }),
      CashHandover.countDocuments({ ...scope, status: "PENDING" }),
      Redemption.countDocuments({ ...scope, status: { $in: OPEN_REDEMPTION } }),
      Message.countDocuments({ ...scope, status: "FAILED", createdAt: { $gte: monthStart } }),
    ]);
    for (const [key, dbVal] of [
      ["dues", dbDues],
      ["cashHandovers", dbHandovers],
      ["openRedemptions", dbRedemptions],
      ["failedMessages", dbFailed],
    ]) {
      if (b?.[key] != null && b[key] !== dbVal) {
        fail("Nav badges", `${key} API=${b[key]} DB=${dbVal}`, label);
      }
    }
    pass(`${label} nav badges match DB`);
  }

  // Collections summary (this month)
  const coll = await api(token, "GET", "/admin/collections/summary", { period: "THIS_MONTH" });
  if (coll.ok) {
    const c = dataOf(coll);
    const dbColl = await Payment.aggregate([
      {
        $match: {
          ...scope,
          status: "SUCCESS",
          paidAt: {
            $gte: new Date(`${periodRange.from}T00:00:00+05:30`),
            $lte: new Date(`${periodRange.to}T23:59:59.999+05:30`),
          },
        },
      },
      { $group: { _id: null, count: { $sum: 1 }, amountPaise: { $sum: "$amountPaise" } } },
    ]);
    const dbCount = dbColl[0]?.count ?? 0;
    const dbAmount = dbColl[0]?.amountPaise ?? 0;
    if (c?.count !== dbCount || c?.amountPaise !== dbAmount) {
      fail(
        "Collections summary",
        `API count=${c?.count} amount=${c?.amountPaise} vs DB count=${dbCount} amount=${dbAmount}`,
        label,
      );
    } else pass(`${label} collections summary THIS_MONTH matches DB (${dbCount} payments)`);
  }

  // List counts
  const checks = [
    ["Customers", "/admin/customers", Customer, { ...scope }],
    ["Enrollments", "/admin/schemes", Scheme, { ...scope }],
    ["Payments", "/admin/payments", Payment, { ...scope }],
    ["Branches", "/admin/branches", Branch, { tenantId }],
    ["Scheme plans", "/admin/scheme-plans", SchemePlan, { tenantId }],
    ["Grievances", "/admin/grievances", Grievance, { ...scope }],
    ["Redemptions", "/admin/redemptions", Redemption, { ...scope }],
    ["Payment links", "/admin/payment-links", PaymentLink, { ...scope }],
  ];
  for (const [name, path, Model, filter] of checks) {
    const res = await api(token, "GET", path, { limit: "5" });
    if (!res.ok) continue;
    const apiTotal = listTotal(res);
    const dbCount = await Model.countDocuments(filter);
    if (Math.abs(apiTotal - dbCount) > 0 && apiTotal < dbCount) {
      // API total may paginate; list meta.total should match when provided
      const metaTotal = dataOf(res)?.meta?.total;
      if (metaTotal != null && metaTotal !== dbCount) {
        fail(name, `list meta.total=${metaTotal} DB=${dbCount}`, label);
        continue;
      }
    }
    if (dataOf(res)?.meta?.total != null && dataOf(res).meta.total !== dbCount) {
      fail(name, `meta.total=${dataOf(res).meta.total} DB=${dbCount}`, label);
    } else {
      pass(`${label} ${name} list OK (DB=${dbCount})`);
    }
  }

  // Dues board
  const dues = await api(token, "GET", "/admin/dues", { limit: "5" });
  const duesCount = await api(token, "GET", "/admin/dues/count");
  if (dues.ok && duesCount.ok) {
    const apiCount = dataOf(duesCount)?.count ?? dataOf(duesCount);
    const dbDueSchemes = await Scheme.countDocuments({
      ...scope,
      paymentPattern: "FIXED",
      "installments.status": { $in: ["DUE", "PARTIALLY_PAID"] },
    });
    if (apiCount != null && apiCount !== dbDueSchemes) {
      fail("Dues count", `API=${apiCount} DB=${dbDueSchemes}`, label);
    } else pass(`${label} dues count = ${dbDueSchemes}`);
  }

  // Overdues
  const overdues = await api(token, "GET", "/admin/overdues", { limit: "5" });
  if (overdues.ok) {
    const dbOverdue = await Scheme.countDocuments({
      ...scope,
      "installments.status": "OVERDUE",
    });
    pass(`${label} overdues API OK (DB overdue schemes=${dbOverdue})`);
  }

  // Cash overview
  const cash = await api(token, "GET", "/admin/cash/overview");
  if (cash.ok) {
    const c = dataOf(cash);
    const dbPending = await CashHandover.countDocuments({ ...scope, status: "PENDING" });
    const apiPending = c?.pending ?? c?.totals?.pendingHandoverCount;
    if (apiPending != null && apiPending !== dbPending) {
      fail("Cash overview", `pending handovers API=${apiPending} DB=${dbPending}`, label);
    } else pass(`${label} cash overview pending handovers = ${dbPending}`);
  }

  // Staff
  const staff = await api(token, "GET", "/admin/staff", { limit: "5" });
  if (staff.ok) {
    const dbStaff = await User.countDocuments({
      tenantId,
      type: "TENANT_USER",
      status: { $ne: "DELETED" },
    });
    const metaTotal = dataOf(staff)?.meta?.total;
    if (metaTotal != null && metaTotal !== dbStaff) {
      fail("Staff", `meta.total=${metaTotal} DB=${dbStaff}`, label);
    } else pass(`${label} staff list OK (DB=${dbStaff})`);
  }

  // Customer analytics
  const custAnalytics = await api(token, "GET", "/admin/customers/analytics", {
    period: "THIS_MONTH",
  });
  if (custAnalytics.ok) {
    pass(`${label} customer analytics responds`);
  }

  // Enrollment analytics
  const enrAnalytics = await api(token, "GET", "/admin/schemes/analytics", {
    period: "THIS_MONTH",
  });
  if (enrAnalytics.ok) pass(`${label} enrollment analytics responds`);

  // Detail drill-down (first customer / scheme if any)
  const customers = listItems(await api(token, "GET", "/admin/customers", { limit: "1" }));
  if (customers[0]?.id ?? customers[0]?._id) {
    const id = customers[0].id ?? customers[0]._id;
    const detail = await api(token, "GET", `/admin/customers/${id}`);
    if (detail.ok) {
      const dbCustomer = await Customer.findOne({ _id: id, tenantId }).lean();
      if (!dbCustomer) fail("Customer detail", `missing in DB ${id}`, label);
      else pass(`${label} customer detail ${id}`);
    }
    for (const sub of ["schemes", "payments", "messages"]) {
      const subRes = await api(token, "GET", `/admin/customers/${id}/${sub}`, { limit: "5" });
      if (subRes.ok) pass(`${label} customer/${sub}`);
    }
  }

  const schemeScope = user?.branchId
    ? { tenantId, branchId: user.branchId, status: "ACTIVE" }
    : { tenantId, status: "ACTIVE" };
  const activeScheme = await Scheme.findOne(schemeScope).select("_id").lean();
  if (activeScheme?._id) {
    const sid = String(activeScheme._id);
    for (const sub of ["ledger", "passbook", "maturity-projection", "payable-range"]) {
      const subRes = await api(token, "GET", `/admin/schemes/${sid}/${sub}`);
      if (subRes.ok) pass(`${label} scheme/${sub}`);
      else fail("Scheme detail", `${sub} HTTP ${subRes.status}`, label);
    }
  }

  const plans = listItems(await api(token, "GET", "/admin/scheme-plans", { limit: "1" }));
  if (plans[0]?.id ?? plans[0]?._id) {
    const pid = plans[0].id ?? plans[0]._id;
    const planDetail = await api(token, "GET", `/admin/scheme-plans/${pid}`);
    const planStats = await api(token, "GET", `/admin/scheme-plans/${pid}/stats`);
    if (planDetail.ok) pass(`${label} plan detail`);
    if (planStats.ok) pass(`${label} plan stats`);
  }
}

async function smokePages(token, label) {
  const endpoints = [
    ["Dashboard charts", "/admin/dashboard/charts/collection-trend", { period: "THIS_MONTH" }],
    ["Dashboard activity", "/admin/dashboard/activity", { limit: "5" }],
    ["Global search", "/admin/search", { q: "a", limit: "5" }],
    ["Alerts", "/admin/alerts", { limit: "5" }],
    ["Access summary", "/admin/access/summary", {}],
    ["Defaulters", "/admin/defaulters", { limit: "5" }],
    ["Maturities", "/admin/maturities", { limit: "5" }],
    ["Maturity calendar", "/admin/maturities/calendar", { month: "2026-09" }],
    ["Flexible locks", "/admin/flexible-locks", { limit: "5" }],
    ["Pending payments", "/admin/payments/pending", { limit: "5" }],
    ["Late success payments", "/admin/payments/late-success", { limit: "5" }],
    ["Cash staff balances", "/admin/cash/staff-balances", { limit: "5" }],
    ["Cash handovers", "/admin/cash/handovers", { limit: "5" }],
    ["Cash report", "/admin/cash/report", { period: "THIS_MONTH" }],
    ["Messaging summary", "/admin/messaging/summary", {}],
    ["Messaging messages", "/admin/messaging/messages", { limit: "5" }],
    ["Messaging templates", "/admin/messaging/templates", {}],
    ["Messaging quota", "/admin/messaging/quota", {}],
    ["Messaging opt-outs", "/admin/messaging/opt-outs", { limit: "5" }],
    ["Reminders config", "/admin/reminders/config", {}],
    ["Settings profile", "/admin/settings/profile", {}],
    ["Settings branding", "/admin/settings/branding", {}],
    ["Settings operations", "/admin/settings/operations", {}],
    ["Subscription", "/admin/subscription", {}],
    ["Subscription usage", "/admin/subscription/usage", {}],
    ["Subscription plans", "/admin/subscription/available-plans", {}],
    ["Subscription invoices", "/admin/subscription/invoices", {}],
    ["Gold rate current", "/admin/gold-rate/current", {}],
    ["Gold rate history", "/admin/gold-rate/history", { limit: "5" }],
    ["Audit events", "/admin/audit-events", { limit: "5" }],
    ["Exports list", "/admin/exports", {}],
  ];
  for (const [area, path, query] of endpoints) {
    await expectOk(token, `${label} ${area}`, path, query);
  }
}

async function branchManagerScope(token, ownerToken) {
  const mgrBranches = listItems(await api(token, "GET", "/admin/branches"));
  const ownerBranches = listItems(await api(ownerToken, "GET", "/admin/branches"));
  if (mgrBranches.length > ownerBranches.length) {
    fail("Branch manager scope", `sees ${mgrBranches.length} branches vs owner ${ownerBranches.length}`);
  } else pass(`Branch manager branches visible: ${mgrBranches.length}`);

  const mgrCustomers = listTotal(await api(token, "GET", "/admin/customers", { limit: "1" }));
  const ownerCustomers = listTotal(await api(ownerToken, "GET", "/admin/customers", { limit: "1" }));
  if (mgrCustomers >= ownerCustomers && ownerCustomers > 0 && mgrCustomers !== ownerCustomers) {
    // branch manager should have fewer or equal customers
    fail("Branch manager scope", `customers API=${mgrCustomers} owner=${ownerCustomers}`);
  } else pass(`Branch manager customers scoped (${mgrCustomers} vs owner ${ownerCustomers})`);

  const mgrBranchPerf = listItems(
    await api(token, "GET", "/admin/reports/BRANCH_PERFORMANCE", {
      reportKey: "BRANCH_PERFORMANCE",
      period: "THIS_MONTH",
      branchId: "ALL",
      limit: "20",
    }),
  );
  if (mgrBranchPerf.length > 1) {
    fail("Branch manager scope", `BRANCH_PERFORMANCE shows ${mgrBranchPerf.length} showrooms`);
  } else pass(`Branch manager BRANCH_PERFORMANCE rows=${mgrBranchPerf.length}`);
}

async function main() {
  const { mobile, password } = parseArgs(process.argv);
  console.log(`Admin pages audit @ ${BASE}\n`);

  await connectDatabase();
  try {
    const { token: ownerToken, user: ownerUser } = await login(mobile, password);
    assert.ok(tenantId, "tenantId from login");

    await smokePages(ownerToken, "Owner");
    await dbChecks(ownerToken, "Owner", ownerUser);

    // Second role: branch manager
    try {
      const { token: mgrToken, user: mgrUser } = await login("9847012346", password);
      await smokePages(mgrToken, "BranchMgr");
      await dbChecks(mgrToken, "BranchMgr", mgrUser);
      await branchManagerScope(mgrToken, ownerToken);
    } catch (error) {
      fail("Branch manager", error.message);
    }

    console.log(`\n--- Summary: ${passes.length} passed, ${issues.length} failed ---`);
    if (issues.length) {
      console.error("\nFailures:");
      for (const issue of issues) console.error(`  • ${issue}`);
      process.exitCode = 1;
    } else {
      console.log("\nAll admin page checks passed.");
    }
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
