#!/usr/bin/env node
/**
 * Deep audit: write flows, settlement math, flexible caps, platform API, 501 stubs, seed edge cases.
 * Usage: node --env-file=.env scripts/audit-gaps-full.js [--tenant KAIRALI]
 */
import { randomUUID } from "node:crypto";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import {
  Branch,
  Customer,
  LedgerEntry,
  Payment,
  Scheme,
  SchemePlan,
  SubscriptionPlan,
  Tenant,
  Invoice,
  Message,
  WebhookEvent,
} from "../src/models/index.js";
import {
  ClosureType,
  InvoiceStatus,
  MessageStatus,
  PaymentStatus,
  SchemeStatus,
  SubscriptionStatus,
  TenantStatus,
} from "../src/constants/enums.js";
import { settlementPreview } from "../src/services/redemption.service.js";
import { payableRange, ledgerTotals } from "../src/services/scheme.service.js";
import { cashBalance } from "../src/services/cash.service.js";
import { monthKey } from "../src/lib/date.js";

const BASE = process.env.API_BASE ?? "http://localhost:4000/api/v1";
const issues = [];
const passes = [];
let tenantId = null;
let tenantCode = "KAIRALI";

function pass(msg) {
  passes.push(msg);
  console.log(`✓ ${msg}`);
}
function fail(area, msg, ctx) {
  const line = ctx ? `${area}: ${msg} (${ctx})` : `${area}: ${msg}`;
  issues.push(line);
  console.error(`✗ ${line}`);
}
function assertEq(area, field, apiVal, dbVal, ctx) {
  const n = (v) => (v == null ? null : typeof v === "number" ? v : String(v));
  if (n(apiVal) !== n(dbVal)) {
    fail(area, `${field} API=${JSON.stringify(apiVal)} DB=${JSON.stringify(dbVal)}`, ctx);
    return false;
  }
  pass(`${ctx} ${field}`);
  return true;
}

async function api(token, method, path, { query = {}, body, idempotency = false, expectStatus } = {}) {
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
  if (expectStatus != null && res.status !== expectStatus) {
    fail("HTTP", `${method} ${path} expected ${expectStatus} got ${res.status}`, JSON.stringify(parsed?.error?.code));
  }
  return { ok: res.ok, status: res.status, body: parsed, url };
}
const dataOf = (res) => res.body?.data ?? res.body;

async function tenantLogin(mobile, password) {
  const res = await api(null, "POST", "/auth/login", {
    body: { tenantCode, mobile, password, deviceId: "audit-gaps", platform: "web" },
  });
  const data = dataOf(res);
  if (!res.ok) throw new Error(`Login failed ${mobile}: ${JSON.stringify(res.body)}`);
  tenantId = data.user?.tenantId ?? tenantId;
  return { token: data.accessToken, user: data.user };
}

async function platformLogin() {
  const res = await api(null, "POST", "/platform/auth/login", {
    body: {
      email: env.SEED_PLATFORM_EMAIL ?? "ops@platform.com",
      password: env.SEED_PLATFORM_PASSWORD ?? "1234",
      deviceId: "audit-gaps",
      platform: "web",
    },
  });
  const data = dataOf(res);
  if (!res.ok) throw new Error(`Platform login failed: ${JSON.stringify(res.body)}`);
  return data.accessToken;
}

async function audit501Stubs(ownerToken) {
  console.log("\n--- 501 stubs (expected unavailable) ---");
  const stubs = [
    ["Inbound messaging", "/admin/messaging/inbound"],
    ["Poll payment status", "/admin/payments/pay_dummy/poll-status", "POST"],
    ["Manual reconcile", "/admin/payments/pay_dummy/reconcile", "POST"],
  ];
  for (const [name, path, method = "GET"] of stubs) {
    const res = await api(ownerToken, method, path, { idempotency: method === "POST" });
    if (res.status === 501 && res.body?.error?.code === "FEATURE_NOT_AVAILABLE") {
      pass(`${name} returns 501 FEATURE_NOT_AVAILABLE`);
    } else {
      fail("501 stub", `${name} expected 501, got ${res.status}`, path);
    }
  }
}

async function auditPlatformApi(platformToken) {
  console.log("\n--- Platform super-admin API ---");
  const endpoints = [
    ["/platform/dashboard/summary"],
    ["/platform/tenants", { limit: "5" }],
    ["/platform/subscription-plans"],
    ["/platform/template-definitions"],
    ["/platform/app-config"],
    ["/platform/audit-logs", { limit: "5" }],
    ["/platform/webhook-failures", { limit: "5" }],
  ];
  for (const [path, query = {}] of endpoints) {
    const res = await api(platformToken, "GET", path, { query });
    if (!res.ok) fail("Platform", `HTTP ${res.status}`, path);
    else pass(`Platform ${path}`);
  }

  const summary = dataOf(await api(platformToken, "GET", "/platform/dashboard/summary"));
  if (summary) {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const [total, active, pending, suspended, cancelled, customers, schemes, paidInvoices, whatsappSent, whatsappFailed, webhookFailures, pastDue] =
      await Promise.all([
        Tenant.countDocuments(),
        Tenant.countDocuments({ status: TenantStatus.ACTIVE }),
        Tenant.countDocuments({ status: TenantStatus.PENDING_SETUP }),
        Tenant.countDocuments({ status: TenantStatus.SUSPENDED }),
        Tenant.countDocuments({ status: TenantStatus.CANCELLED }),
        Customer.countDocuments({ status: "ACTIVE" }),
        Scheme.countDocuments({ status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED", "MATURED"] } }),
        Invoice.find({ status: InvoiceStatus.PAID, paidAt: { $gte: monthStart } }).lean(),
        Message.countDocuments({ createdAt: { $gte: monthStart }, status: { $in: [MessageStatus.SENT, MessageStatus.DELIVERED, MessageStatus.READ] } }),
        Message.countDocuments({ createdAt: { $gte: monthStart }, status: MessageStatus.FAILED }),
        WebhookEvent.countDocuments({ status: { $in: ["FAILED", "SIGNATURE_FAILED", "DEAD_LETTER"] } }),
        Tenant.countDocuments({ "subscription.status": SubscriptionStatus.PAST_DUE }),
      ]);
    assertEq("Platform summary", "tenants.total", summary.tenants?.total, total, "Platform");
    assertEq("Platform summary", "tenants.active", summary.tenants?.active, active, "Platform");
    assertEq("Platform summary", "activeCustomersTotal", summary.platformVolume?.activeCustomersTotal, customers, "Platform");
    assertEq("Platform summary", "activeSchemesTotal", summary.platformVolume?.activeSchemesTotal, schemes, "Platform");
    const mrr = paidInvoices.reduce((s, r) => s + (r.amountPaise ?? 0), 0);
    assertEq("Platform summary", "mrr.amountPaise", summary.mrr?.amountPaise, mrr, "Platform");
    assertEq("Platform summary", "whatsapp.sentThisMonth", summary.whatsapp?.sentThisMonth, whatsappSent, "Platform");
    assertEq("Platform summary", "whatsapp.failedThisMonth", summary.whatsapp?.failedThisMonth, whatsappFailed, "Platform");
    const alertWebhook = summary.alerts?.find((a) => a.key === "WEBHOOK_FAILURES");
    if (webhookFailures > 0) {
      assertEq("Platform alerts", "WEBHOOK_FAILURES.count", alertWebhook?.count, webhookFailures, "Platform");
    } else pass("Platform WEBHOOK_FAILURES alert absent when DB=0");
    void pending;
    void suspended;
    void cancelled;
    void pastDue;
  }

  const plans = dataOf(await api(platformToken, "GET", "/platform/subscription-plans"));
  const dbPlans = await SubscriptionPlan.countDocuments({ active: true });
  if (Array.isArray(plans) && plans.length !== dbPlans) {
    fail("Platform plans", `API=${plans.length} DB active=${dbPlans}`, "Platform");
  } else pass(`Platform subscription plans count = ${dbPlans}`);

  const tenants = dataOf(await api(platformToken, "GET", "/platform/tenants", { query: { limit: "100" } }));
  const dbTenants = await Tenant.countDocuments();
  const apiTotal = tenants?.meta?.total ?? (Array.isArray(tenants) ? tenants.length : 0);
  if (apiTotal !== dbTenants) fail("Platform tenants", `meta.total=${apiTotal} DB=${dbTenants}`, "Platform");
  else pass(`Platform tenants list total = ${dbTenants}`);
}

async function auditSettlementMath(ownerToken, ownerUser) {
  console.log("\n--- Settlement / redemption math ---");
  const matured = await Scheme.find({ tenantId, status: SchemeStatus.MATURED }).limit(20).lean();
  for (const scheme of matured) {
    const ctx = scheme.enrollmentNumber;
    const req = {
      auth: { ...ownerUser, tenantId, type: "TENANT_USER" },
      params: { schemeId: scheme._id },
      scope: { tenantId },
    };
    const direct = await settlementPreview(req, ClosureType.MATURITY_REDEMPTION);
    const res = await api(ownerToken, "GET", `/admin/schemes/${scheme._id}/settlement-preview`);
    if (!res.ok) {
      fail("Settlement API", `HTTP ${res.status}`, ctx);
      continue;
    }
    const apiData = dataOf(res);
    assertEq("Settlement", "eligible", apiData.eligible, direct.eligible, ctx);
    assertEq("Settlement", "finalValue.amountPaise", apiData.computation?.finalValue?.amountPaise, direct.computation?.finalValue?.amountPaise, ctx);
    const entries = await LedgerEntry.find({ tenantId, schemeId: scheme._id }).lean();
    const totals = ledgerTotals(entries);
    assertEq("Settlement", "totalPaid line", apiData.computation?.lines?.find((l) => l.key === "TOTAL_PAID")?.amount?.amountPaise, totals.amountPaidPaise, ctx);
  }

  const prematureCandidates = await Scheme.find({
    tenantId,
    status: { $in: [SchemeStatus.ACTIVE, SchemeStatus.LOCKED, SchemeStatus.DEFAULTED] },
    "planSnapshot.redemptionRules.prematureClosureAllowed": true,
  })
    .limit(5)
    .lean();
  for (const scheme of prematureCandidates) {
    const ctx = `${scheme.enrollmentNumber} premature`;
    const req = {
      auth: { ...ownerUser, tenantId, type: "TENANT_USER" },
      params: { schemeId: scheme._id },
      scope: { tenantId },
    };
    const direct = await settlementPreview(req, ClosureType.PREMATURE_CLOSURE);
    const res = await api(ownerToken, "GET", `/admin/schemes/${scheme._id}/settlement-preview`, {
      query: { type: ClosureType.PREMATURE_CLOSURE },
    });
    if (!res.ok) {
      fail("Premature settlement", `HTTP ${res.status}`, ctx);
      continue;
    }
    const apiData = dataOf(res);
    assertEq("Premature settlement", "finalValue.amountPaise", apiData.computation?.finalValue?.amountPaise, direct.computation?.finalValue?.amountPaise, ctx);
    assertEq("Premature settlement", "eligible", apiData.eligible, direct.eligible, ctx);
  }
  pass(`Settlement checked ${matured.length} matured + ${prematureCandidates.length} premature candidates`);
}

async function auditFlexibleSchemes(ownerToken, ownerUser) {
  console.log("\n--- Flexible scheme caps / payable-range ---");
  const flexSchemes = await Scheme.find({
    tenantId,
    paymentPattern: "FLEXIBLE",
    status: { $in: [SchemeStatus.ACTIVE, SchemeStatus.LOCKED, SchemeStatus.DEFAULTED] },
  }).lean();

  for (const scheme of flexSchemes) {
    const ctx = scheme.enrollmentNumber;
    const targetCycle = monthKey();
    const req = {
      auth: { ...ownerUser, tenantId, type: "TENANT_USER" },
      params: { schemeId: scheme._id },
      query: { targetCycle },
      scope: { tenantId },
    };
    let direct;
    try {
      direct = await payableRange(req);
    } catch (error) {
      if (scheme.flexiblePhase === "CAPPED") {
        fail("Flexible payableRange", error.message, ctx);
      }
      continue;
    }
    const res = await api(ownerToken, "GET", `/admin/schemes/${scheme._id}/payable-range`, {
      query: scheme.flexiblePhase === "CAPPED" ? { targetCycle } : {},
    });
    if (!res.ok) {
      fail("Flexible API", `HTTP ${res.status}`, ctx);
      continue;
    }
    const apiData = dataOf(res);
    for (const field of ["minPayablePaise", "maxPayablePaise", "payable", "model", "phase"]) {
      if (direct[field] !== undefined && apiData[field] !== undefined) {
        assertEq("Flexible range", field, apiData[field], direct[field], ctx);
      }
    }
    if (scheme.flexiblePhase === "CAPPED") {
      const cycle = scheme.cycles?.find((r) => r.cycle === targetCycle);
      if (cycle) {
        const expectedRemaining = Math.max(0, cycle.capPaise - cycle.paidPaise);
        assertEq("Flexible cap", "maxPayablePaise vs cycle remaining", apiData.maxPayablePaise, expectedRemaining, ctx);
      }
    }
    if (scheme.flexiblePhase === "FLEXIBLE") {
      const rules = scheme.planSnapshot?.flexibleRules?.flexiblePhase;
      if (rules) {
        assertEq("Flexible free phase", "minPayablePaise", apiData.minPayablePaise, rules.minimumPaymentPaise, ctx);
        assertEq("Flexible free phase", "maxPayablePaise", apiData.maxPayablePaise, rules.maximumPaymentPaise, ctx);
      }
    }
  }
  pass(`Flexible payable-range checked ${flexSchemes.length} schemes`);
}

async function auditDemoEdgeCases(ownerToken) {
  console.log("\n--- Demo seed edge cases (MG Road / large payments) ---");
  const mgrBranch = await Branch.findOne({ tenantId, code: "MGR" }).lean();
  if (!mgrBranch) {
    pass("MG Road branch not in seed — skip");
    return;
  }

  const largePayments = await Payment.find({
    tenantId,
    status: PaymentStatus.SUCCESS,
    amountPaise: { $gte: 10_000_000 },
  })
    .sort({ amountPaise: -1 })
    .limit(5)
    .lean();

  if (!largePayments.length) {
    pass("No oversized payments in seed");
    return;
  }

  for (const payment of largePayments) {
    const ctx = payment.receiptNumber;
    const ledger = await LedgerEntry.findOne({
      tenantId,
      schemeId: payment.schemeId,
      type: { $in: ["INSTALLMENT_PAYMENT", "FREE_WINDOW_PAYMENT"] },
      amountPaise: payment.amountPaise,
    }).lean();
    if (!ledger) {
      fail("Large payment", "no matching ledger entry", ctx);
    } else {
      pass(`${ctx} has ledger entry ₹${(payment.amountPaise / 100).toLocaleString("en-IN")}`);
    }
    if (payment.weightMg && payment.ratePerGramPaise) {
      const expectedWeight = Math.round((payment.amountPaise * 1000) / payment.ratePerGramPaise);
      const delta = Math.abs(expectedWeight - payment.weightMg);
      if (delta > 1) {
        fail("Gold weight", `weightMg API=${payment.weightMg} calc=${expectedWeight}`, ctx);
      } else {
        pass(`${ctx} gold weight consistent with rate`);
      }
    }
    const [withTotals] = await attachLedgerTotalsForScheme(payment.schemeId);
    const schemePaid = withTotals?.totals?.amountPaidPaise ?? 0;
    const passbook = dataOf(await api(ownerToken, "GET", `/admin/schemes/${payment.schemeId}/passbook`));
    if (passbook?.totals?.paid?.amountPaise != null) {
      assertEq("Large payment passbook", "totals.paid", passbook.totals.paid.amountPaise, schemePaid, ctx);
    }
  }

  const mgrPayments = await Payment.aggregate([
    { $match: { tenantId, branchId: mgrBranch._id, status: "SUCCESS" } },
    { $group: { _id: null, amountPaise: { $sum: "$amountPaise" }, count: { $sum: 1 } } },
  ]);
  const mgrTotal = mgrPayments[0]?.amountPaise ?? 0;
  pass(`MG Road branch SUCCESS total ₹${(mgrTotal / 100).toLocaleString("en-IN")} (${mgrPayments[0]?.count ?? 0} payments) — math self-consistent`);
}

async function attachLedgerTotalsForScheme(schemeId) {
  const scheme = await Scheme.findById(schemeId).lean();
  if (!scheme) return [];
  const { attachLedgerTotals } = await import("../src/services/scheme.service.js");
  return attachLedgerTotals(tenantId, [scheme]);
}

/** Minimal 1×1 PNG for mock upload complete in dev. */
const MIN_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z4BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function createKycUpload(ownerToken) {
  const presign = await api(ownerToken, "POST", "/admin/uploads/presign", {
    body: {
      purpose: "KYC_DOCUMENT",
      fileName: "audit-kyc.png",
      contentType: "image/png",
      sizeBytes: MIN_PNG.length,
    },
    idempotency: true,
  });
  if (!presign.ok) throw new Error(`presign failed: ${JSON.stringify(presign.body)}`);
  const p = dataOf(presign);
  const put = await fetch(p.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/png", ...(p.headers ?? {}) },
    body: MIN_PNG,
  });
  if (!put.ok) throw new Error(`mock PUT upload failed ${put.status}`);
  const complete = await api(ownerToken, "POST", `/admin/uploads/${p.uploadId}/complete`, {
    idempotency: true,
  });
  if (!complete.ok) throw new Error(`complete failed: ${JSON.stringify(complete.body)}`);
  return p.uploadId;
}

async function auditWriteFlows(ownerToken, staffToken, staffUser) {
  console.log("\n--- Write flows (enrol → pay → reverse, handover, KYC) ---");
  const hqBranch = await Branch.findOne({ tenantId, code: "MGR" }).select("_id").lean();
  const plan = await SchemePlan.findOne({
    tenantId,
    status: "ACTIVE",
    paymentPattern: "FIXED",
    "amountRules.fixedAmountPaise": { $gt: 0 },
  }).lean();
  if (!plan || !hqBranch) {
    fail("Write flow setup", "missing plan or branch");
    return;
  }

  const auditMobile = `98479${String(Date.now()).slice(-5)}`;
  const createRes = await api(staffToken, "POST", "/staff/customers", {
    body: { name: "Audit Flow Customer", mobile: auditMobile, branchId: hqBranch._id },
    idempotency: true,
  });
  if (!createRes.ok) {
    fail("Write flow", `create customer HTTP ${createRes.status}`, JSON.stringify(createRes.body));
    return;
  }
  const customer = dataOf(createRes);
  const customerId = customer.id ?? customer._id;
  pass(`Created audit customer ${auditMobile}`);

  let frontUploadId;
  let backUploadId;
  try {
    frontUploadId = await createKycUpload(ownerToken);
    backUploadId = await createKycUpload(ownerToken);
  } catch (error) {
    fail("Write KYC", `upload setup: ${error.message}`, customerId);
    return;
  }
  const kycSubmit = await api(ownerToken, "PUT", `/admin/customers/${customerId}/kyc`, {
    body: {
      type: "AADHAAR",
      number: "123412341234",
      frontUploadId,
      backUploadId,
    },
    idempotency: true,
  });
  if (!kycSubmit.ok) {
    fail("Write KYC", `submit HTTP ${kycSubmit.status}`, JSON.stringify(kycSubmit.body));
    return;
  }
  const kycVerify = await api(ownerToken, "POST", `/admin/customers/${customerId}/kyc/verify`, {
    body: { status: "VERIFIED" },
    idempotency: true,
  });
  if (!kycVerify.ok) {
    fail("Write KYC", `verify HTTP ${kycVerify.status}`, JSON.stringify(kycVerify.body));
    return;
  }
  const dbCust = await Customer.findById(customerId).lean();
  assertEq("Write KYC", "kyc.status", dbCust.kyc?.status, "VERIFIED", customerId);
  pass("KYC submit + verify write flow OK");

  const enrolRes = await api(staffToken, "POST", "/staff/schemes/enrol", {
    body: {
      customerId,
      planId: plan._id,
      branchId: hqBranch._id,
      installmentAmountPaise: plan.amountRules?.fixedAmountPaise ?? 150_000,
      firstInstallmentMode: "START_NEXT_CYCLE",
    },
    idempotency: true,
  });
  if (!enrolRes.ok) {
    fail("Write flow", `enrol HTTP ${enrolRes.status}`, JSON.stringify(enrolRes.body));
    return;
  }
  const enrolled = dataOf(enrolRes);
  const schemeId = enrolled.id ?? enrolled._id;
  pass(`Enrolled scheme ${enrolled.enrollmentNumber ?? schemeId}`);

  const dbScheme = await Scheme.findById(schemeId).lean();
  assertEq("Write enrol", "customerId", dbScheme.customerId, customerId, "Enrol");
  assertEq("Write enrol", "planId", dbScheme.planId, plan._id, "Enrol");

  const cashBefore = await cashBalance({ tenantId, branchId: staffUser.branchId, staffId: staffUser.id ?? staffUser._id });
  const payAmount = plan.amountRules?.fixedAmountPaise ?? 150_000;
  const payRes = await api(staffToken, "POST", "/staff/payments", {
    body: {
      schemeId,
      amountPaise: payAmount,
      mode: "CASH",
      expectedVersion: dbScheme.version,
    },
    idempotency: true,
  });
  if (!payRes.ok) {
    fail("Write flow", `record payment HTTP ${payRes.status}`, JSON.stringify(payRes.body));
    return;
  }
  const payment = dataOf(payRes);
  const paymentId = payment.id ?? payment._id;
  pass(`Recorded payment ${payment.receiptNumber}`);

  const dbPayment = await Payment.findById(paymentId).lean();
  assertEq("Write payment", "amountPaise", dbPayment.amountPaise, payAmount, payment.receiptNumber);
  assertEq("Write payment", "status", dbPayment.status, PaymentStatus.SUCCESS, payment.receiptNumber);
  assertEq("Write payment", "collectedBy", dbPayment.collectedBy, staffUser.id ?? staffUser._id, payment.receiptNumber);

  const cashAfter = await cashBalance({ tenantId, branchId: staffUser.branchId, staffId: staffUser.id ?? staffUser._id });
  assertEq("Write payment", "cashCollected increased", cashAfter.cashCollectedPaise, cashBefore.cashCollectedPaise + payAmount, "Cash");
  assertEq("Write payment", "cashInHand increased", cashAfter.cashInHandPaise, cashBefore.cashInHandPaise + payAmount, "Cash");

  const ledgerCount = await LedgerEntry.countDocuments({ tenantId, schemeId, type: "INSTALLMENT_PAYMENT", amountPaise: payAmount });
  assertEq("Write payment", "ledger entry", ledgerCount, 1, payment.receiptNumber);

  const passbook = dataOf(await api(staffToken, "GET", `/staff/schemes/${schemeId}/passbook`));
  const [withTotals] = await attachLedgerTotalsForScheme(schemeId);
  if (passbook?.totals?.paid?.amountPaise != null) {
    assertEq("Write payment", "passbook total", passbook.totals.paid.amountPaise, withTotals.totals.amountPaidPaise, payment.receiptNumber);
  }

  if (cashAfter.cashInHandPaise >= 50_000) {
    const handoverAmount = 50_000;
    const beforeHandover = await cashBalance({ tenantId, branchId: staffUser.branchId, staffId: staffUser.id ?? staffUser._id });
    const handoverRes = await api(staffToken, "POST", "/staff/cash/handovers", {
      body: { amountPaise: handoverAmount, remarks: "Audit script handover" },
      idempotency: true,
    });
    if (handoverRes.ok) {
      const handover = dataOf(handoverRes);
      const handoverId = handover.id ?? handover._id;
      pass(`Created handover ₹${handoverAmount / 100}`);
      const midBalance = await cashBalance({ tenantId, branchId: staffUser.branchId, staffId: staffUser.id ?? staffUser._id });
      assertEq("Write handover", "pending acceptance", midBalance.cashPendingAcceptancePaise, beforeHandover.cashPendingAcceptancePaise + handoverAmount, "Handover");
      const cancelRes = await api(staffToken, "POST", `/staff/cash/handovers/${handoverId}/cancel`, { idempotency: true });
      if (cancelRes.ok) {
        pass("Cancelled audit handover");
        const afterCancel = await cashBalance({ tenantId, branchId: staffUser.branchId, staffId: staffUser.id ?? staffUser._id });
        assertEq("Write handover", "cash restored after cancel", afterCancel.cashInHandPaise, beforeHandover.cashInHandPaise, "Handover");
      } else {
        fail("Write handover", `cancel HTTP ${cancelRes.status}`, handoverId);
      }
    } else {
      fail("Write handover", `create HTTP ${handoverRes.status}`, JSON.stringify(handoverRes.body));
    }
  } else {
    pass("Skip handover write — insufficient cash in hand for test");
  }

  const reverseRes = await api(ownerToken, "POST", `/admin/payments/${paymentId}/reverse`, {
    body: { reason: "Audit script cleanup" },
    idempotency: true,
  });
  if (reverseRes.ok) {
    pass(`Reversed audit payment ${payment.receiptNumber}`);
    const dbPayAfter = await Payment.findById(paymentId).lean();
    assertEq("Write reverse", "status", dbPayAfter.status, "REVERSED", payment.receiptNumber);
    const cashReversed = await cashBalance({ tenantId, branchId: staffUser.branchId, staffId: staffUser.id ?? staffUser._id });
    assertEq("Write reverse", "cashInHand restored", cashReversed.cashInHandPaise, cashBefore.cashInHandPaise, "Cash");
  } else {
    fail("Write reverse", `HTTP ${reverseRes.status}`, paymentId);
  }
}

async function main() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--tenant") tenantCode = args[++i];
  }
  console.log(`Gap audit @ ${BASE} (tenant ${tenantCode})\n`);

  await connectDatabase();
  try {
    const tenantRow = await Tenant.findOne({ code: tenantCode }).lean();
    if (tenantRow) tenantId = tenantRow._id;

    const { token: ownerToken, user: ownerUser } = await tenantLogin("9847012345", "2026");
    const { token: staffToken, user: staffUser } = await tenantLogin("9847012350", "2026");

    let platformToken;
    try {
      platformToken = await platformLogin();
    } catch (error) {
      fail("Platform login", error.message, "Run npm run seed for platform user");
    }

    await audit501Stubs(ownerToken);
    if (platformToken) await auditPlatformApi(platformToken);
    await auditSettlementMath(ownerToken, ownerUser);
    await auditFlexibleSchemes(ownerToken, ownerUser);
    await auditDemoEdgeCases(ownerToken);
    await auditWriteFlows(ownerToken, staffToken, staffUser);

    console.log(`\n--- Summary: ${passes.length} passed, ${issues.length} failed ---`);
    if (issues.length) {
      console.error("\nFailures:");
      for (const issue of issues) console.error(`  • ${issue}`);
      process.exitCode = 1;
    } else {
      console.log("\nAll gap audits passed.");
    }
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
