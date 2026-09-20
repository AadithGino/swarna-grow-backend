import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  FirstInstallmentMode,
  PaymentIntentStatus,
  PaymentMode,
  PaymentStatus,
  RedemptionMode,
  SchemePlanStatus,
  SchemeStatus,
  TenantRole,
} from "../src/constants/enums.js";
import {
  Alert,
  LedgerEntry,
  OutboxEvent,
  Payment,
  PaymentIntent,
  Scheme,
  SchemePlan,
  Tenant,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { withTransaction } from "../src/lib/transaction.js";
import { applyTerminalGatewayFailure } from "../src/services/gateway-terminal-failure.service.js";
import {
  createEnrolmentInSession,
  enrol,
  validateEnrolment,
} from "../src/services/scheme.service.js";
import { finalizeGatewaySuccess } from "../src/services/finalize-gateway-success.service.js";
import {
  ENROLMENT_CAPACITY_STATUSES,
  ONE_ACTIVE_SCHEME_CONFLICT_STATUSES,
} from "../src/lib/scheme-enrollment-status.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

const redemptionRules = {
  prematureClosureAllowed: false,
  lockInMonths: 0,
  prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
  allowedModes: [RedemptionMode.CASH],
  redeemAtAnyBranch: false,
};

const benefit = {
  type: "TEXT_ONLY",
  displayLabel: "Benefit",
  eligibility: {
    requireAllInstallmentsPaid: true,
    maxAllowedDefaults: 0,
    minMonthsCompleted: 0,
  },
};

function buildFixedPlan(tenantId, code, overrides = {}) {
  return {
    _id: createId("schemePlan"),
    tenantId,
    name: `Plan ${code}`,
    code,
    status: SchemePlanStatus.ACTIVE,
    paymentPattern: "FIXED",
    valueBasis: "CASH",
    durationMonths: 12,
    installmentCount: 12,
    version: 1,
    amountRules: { amountMode: "JEWELLER_FIXED", fixedAmountPaise: 100_000 },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      firstInstallmentModeDefault: FirstInstallmentMode.START_NEXT_CYCLE,
    },
    paymentRules: { partialPaymentAllowed: false, minPaymentPaise: 100_000 },
    redemptionRules,
    benefit,
    availability: {
      allBranches: true,
      branchIds: [],
      visibleInCustomerApp: true,
      customerSelfEnrolAllowed: true,
    },
    ...overrides,
  };
}

async function tenantWithPolicy(oneActive) {
  const seeded = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await Tenant.updateOne(
    { _id: seeded.tenant._id },
    { $set: { "settings.oneActiveSchemePerCustomer": oneActive } },
  );
  const tenant = await Tenant.findById(seeded.tenant._id).lean();
  return { ...seeded, tenant };
}

function enrolReq({ tenant, branch, user, customerId, planId, body = {} }) {
  return {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    tenant,
    headers: {},
    ip: "127.0.0.1",
    baseUrl: "/admin",
    body: {
      customerId,
      planId,
      branchId: branch._id,
      installmentAmountPaise: 100_000,
      firstInstallmentMode: FirstInstallmentMode.START_NEXT_CYCLE,
      ...body,
    },
  };
}

async function createTwoPlans(tenantId) {
  const planA = buildFixedPlan(tenantId, "PLANAA");
  const planB = buildFixedPlan(tenantId, "PLANBB");
  await SchemePlan.insertMany([planA, planB]);
  return { planA, planB };
}

test("one-active policy: concurrent enrolments on two plans — exactly one succeeds", async () => {
  const { tenant, branch, user } = await tenantWithPolicy(true);
  const { planA, planB } = await createTwoPlans(tenant._id);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const results = await Promise.allSettled([
    enrol(enrolReq({ tenant, branch, user, customerId: customer._id, planId: planA._id })),
    enrol(enrolReq({ tenant, branch, user, customerId: customer._id, planId: planB._id })),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason?.code, "ONE_SCHEME_POLICY");
  assert.equal(await Scheme.countDocuments({ tenantId: tenant._id, customerId: customer._id }), 1);
});

test("one-active policy disabled: concurrent enrolments on two plans both succeed", async () => {
  const { tenant, branch, user } = await tenantWithPolicy(false);
  const { planA, planB } = await createTwoPlans(tenant._id);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const results = await Promise.allSettled([
    enrol(enrolReq({ tenant, branch, user, customerId: customer._id, planId: planA._id })),
    enrol(enrolReq({ tenant, branch, user, customerId: customer._id, planId: planB._id })),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal(await Scheme.countDocuments({ tenantId: tenant._id, customerId: customer._id }), 2);
});

for (const status of ["MATURED", "ENROLMENT_EXPIRED", "CLOSED_PREMATURE", "REDEEMED"]) {
  test(`one-active policy: existing ${status} scheme does not block new enrolment`, async () => {
    const { tenant, branch, user } = await tenantWithPolicy(true);
    const { planA, planB } = await createTwoPlans(tenant._id);
    const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
    await Scheme.create({
      _id: createId("scheme"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: customer._id,
      planId: planA._id,
      enrollmentNumber: `ENR-${status}-001`,
      planSnapshot: { paymentPattern: "FIXED" },
      valueBasis: "CASH",
      paymentPattern: "FIXED",
      status,
      startDate: "2026-01-01",
      maturityDate: "2026-12-31",
      installmentAmountPaise: 100_000,
      version: 1,
    });
    const created = await enrol(enrolReq({
      tenant, branch, user, customerId: customer._id, planId: planB._id,
    }));
    assert.ok(created._id);
    assert.equal(await Scheme.countDocuments({ tenantId: tenant._id, customerId: customer._id }), 2);
  });
}

for (const status of ONE_ACTIVE_SCHEME_CONFLICT_STATUSES) {
  test(`one-active policy: existing ${status} scheme blocks new enrolment`, async () => {
    const { tenant, branch, user } = await tenantWithPolicy(true);
    const { planA, planB } = await createTwoPlans(tenant._id);
    const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
    await Scheme.create({
      _id: createId("scheme"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: customer._id,
      planId: planA._id,
      enrollmentNumber: "ENR-0000002",
      planSnapshot: { paymentPattern: "FIXED" },
      valueBasis: "CASH",
      paymentPattern: "FIXED",
      status,
      startDate: "2026-01-01",
      maturityDate: "2026-12-31",
      installmentAmountPaise: 100_000,
      version: 1,
    });
    await assert.rejects(
      () => enrol(enrolReq({ tenant, branch, user, customerId: customer._id, planId: planB._id })),
      (error) => error.code === "ONE_SCHEME_POLICY",
    );
  });
}

test("one-active policy: different customers enrol concurrently without interference", async () => {
  const { tenant, branch, user } = await tenantWithPolicy(true);
  const { planA } = await createTwoPlans(tenant._id);
  const customerA = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: `+9191${String(Date.now()).slice(-8)}`,
  });
  const customerB = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: `+9192${String(Date.now()).slice(-8)}`,
  });
  const results = await Promise.allSettled([
    enrol(enrolReq({ tenant, branch, user, customerId: customerA._id, planId: planA._id })),
    enrol(enrolReq({ tenant, branch, user, customerId: customerB._id, planId: planA._id })),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
});

test("one-active policy: different tenants remain isolated", async () => {
  const a = await tenantWithPolicy(true);
  const b = await tenantWithPolicy(true);
  const planA = buildFixedPlan(a.tenant._id, "ISOA");
  const planB = buildFixedPlan(b.tenant._id, "ISOB");
  await SchemePlan.create(planA);
  await SchemePlan.create(planB);
  const customerA = await seedCustomer({ tenantId: a.tenant._id, branchId: a.branch._id });
  const customerB = await seedCustomer({ tenantId: b.tenant._id, branchId: b.branch._id });
  await Promise.all([
    enrol(enrolReq({
      tenant: a.tenant, branch: a.branch, user: a.user, customerId: customerA._id, planId: planA._id,
    })),
    enrol(enrolReq({
      tenant: b.tenant, branch: b.branch, user: b.user, customerId: customerB._id, planId: planB._id,
    })),
  ]);
  assert.equal(await Scheme.countDocuments({ tenantId: a.tenant._id }), 1);
  assert.equal(await Scheme.countDocuments({ tenantId: b.tenant._id }), 1);
});

test("transaction revalidation rejects deactivated plan and creates no scheme", async () => {
  const { tenant, branch, user } = await tenantWithPolicy(false);
  const plan = buildFixedPlan(tenant._id, "DEACT");
  await SchemePlan.create(plan);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const req = enrolReq({ tenant, branch, user, customerId: customer._id, planId: plan._id });
  const validation = await validateEnrolment(req);
  await SchemePlan.updateOne({ _id: plan._id }, { $set: { status: SchemePlanStatus.INACTIVE } });
  await assert.rejects(
    () => withTransaction((session) => createEnrolmentInSession(req, validation, session)),
    (error) => error.code === "PLAN_ENROLMENT_CLOSED",
  );
  assert.equal(await Scheme.countDocuments({ tenantId: tenant._id }), 0);
  assert.equal(await Payment.countDocuments({ tenantId: tenant._id }), 0);
});

test("transaction revalidation rejects stale installment amount after plan amount change", async () => {
  const { tenant, branch, user } = await tenantWithPolicy(false);
  const plan = buildFixedPlan(tenant._id, "AMTCHG");
  await SchemePlan.create(plan);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const req = enrolReq({ tenant, branch, user, customerId: customer._id, planId: plan._id });
  const validation = await validateEnrolment(req);
  await SchemePlan.updateOne(
    { _id: plan._id },
    { $set: { "amountRules.fixedAmountPaise": 200_000, "amountRules.minInstallmentPaise": 200_000 } },
  );
  await assert.rejects(
    () => withTransaction((session) => createEnrolmentInSession(req, validation, session)),
    (error) => error.code === "INVALID_INSTALLMENT_AMOUNT",
  );
  assert.equal(await Scheme.countDocuments({ tenantId: tenant._id }), 0);
});

test("manual first payment enrolment returns ACTIVE scheme and one scheme.joined event", async () => {
  const { tenant, branch, user } = await tenantWithPolicy(false);
  const plan = buildFixedPlan(tenant._id, "MANUAL", {
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      firstInstallmentModeDefault: FirstInstallmentMode.COLLECT_NOW,
    },
  });
  await SchemePlan.create(plan);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const result = await enrol(enrolReq({
    tenant,
    branch,
    user,
    customerId: customer._id,
    planId: plan._id,
    body: {
      firstInstallmentMode: FirstInstallmentMode.COLLECT_NOW,
      firstInstallmentAction: "RECORD_MANUAL_PAYMENT",
      payment: { amountPaise: 100_000, mode: "CASH" },
    },
  }));
  assert.equal(result.status, SchemeStatus.ACTIVE);
  const persisted = await Scheme.findById(result._id).lean();
  assert.equal(persisted.status, SchemeStatus.ACTIVE);
  assert.equal(await Payment.countDocuments({ tenantId: tenant._id, schemeId: result._id }), 1);
  assert.equal(await LedgerEntry.countDocuments({ tenantId: tenant._id, schemeId: result._id }), 1);
  assert.equal(
    await OutboxEvent.countDocuments({ tenantId: tenant._id, topic: "scheme.joined", key: result._id }),
    1,
  );
});

async function seedPendingEnrolCheckout({ tenant, branch, user, customer }) {
  const plan = buildFixedPlan(tenant._id, "PENDG", {
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      firstInstallmentModeDefault: FirstInstallmentMode.COLLECT_NOW,
    },
    paymentRules: {
      partialPaymentAllowed: true,
      advancePaymentAllowed: false,
      minPaymentPaise: 100_000,
    },
  });
  await SchemePlan.create(plan);
  const enrolled = await enrol(enrolReq({
    tenant,
    branch,
    user,
    customerId: customer._id,
    planId: plan._id,
    body: {
      firstInstallmentMode: FirstInstallmentMode.COLLECT_NOW,
    },
  }));
  assert.equal(enrolled.status, SchemeStatus.PENDING_PAYMENT);
  const paymentId = createId("payment");
  const intentId = createId("paymentIntent");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: enrolled._id,
    customerId: customer._id,
    receiptNumber: `PENDING-${intentId}`,
    amountPaise: 100_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(),
  });
  await PaymentIntent.create({
    _id: intentId,
    tenantId: tenant._id,
    schemeId: enrolled._id,
    customerId: customer._id,
    paymentId,
    amountPaise: 100_000,
    status: PaymentIntentStatus.PENDING,
    targetCycle: "2026-04",
    positionVersion: 1,
    reservationExpiresAt: new Date(Date.now() + 3600_000),
    version: 1,
  });
  const payment = await Payment.findById(paymentId).lean();
  const intent = await PaymentIntent.findById(intentId).lean();
  return { plan, enrolled, payment, intent };
}

test("terminal gateway failure expires unpaid pending enrolment", async () => {
  const { tenant, branch, user } = await tenantWithPolicy(false);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { enrolled, payment, intent } = await seedPendingEnrolCheckout({
    tenant, branch, user, customer,
  });
  const result = await applyTerminalGatewayFailure({
    tenantId: tenant._id,
    paymentId: payment._id,
    reference: intent._id,
  });
  assert.ok(result.paymentId);
  const scheme = await Scheme.findById(enrolled._id).lean();
  assert.equal(scheme.status, SchemeStatus.ENROLMENT_EXPIRED);
  assert.equal(
    (await Payment.findById(payment._id).lean()).status,
    PaymentStatus.FAILED,
  );
  assert.equal(
    await OutboxEvent.countDocuments({ tenantId: tenant._id, topic: "scheme.enrolment.expired", key: enrolled._id }),
    1,
  );
});

test("pending payment without terminal failure stays PENDING_PAYMENT", async () => {
  const { tenant, branch, user } = await tenantWithPolicy(false);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { enrolled } = await seedPendingEnrolCheckout({ tenant, branch, user, customer });
  const scheme = await Scheme.findById(enrolled._id).lean();
  assert.equal(scheme.status, SchemeStatus.PENDING_PAYMENT);
});

test("allocated success payment prevents enrolment expiry on terminal failure skip path", async () => {
  const { tenant, branch, user } = await tenantWithPolicy(false);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const plan = buildFixedPlan(tenant._id, "ALLOK", {
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      firstInstallmentModeDefault: FirstInstallmentMode.COLLECT_NOW,
    },
  });
  await SchemePlan.create(plan);
  const enrolled = await enrol(enrolReq({
    tenant,
    branch,
    user,
    customerId: customer._id,
    planId: plan._id,
    body: {
      firstInstallmentMode: FirstInstallmentMode.COLLECT_NOW,
      firstInstallmentAction: "RECORD_MANUAL_PAYMENT",
      payment: { amountPaise: 100_000, mode: "CASH" },
    },
  }));
  assert.equal(enrolled.status, SchemeStatus.ACTIVE);
  const payment = await Payment.findOne({ tenantId: tenant._id, schemeId: enrolled._id }).lean();
  const result = await applyTerminalGatewayFailure({
    tenantId: tenant._id,
    paymentId: payment._id,
  });
  assert.ok(result.skipped);
  assert.equal(result.reason, "ALREADY_SUCCESS");
  assert.equal((await Scheme.findById(enrolled._id).lean()).status, SchemeStatus.ACTIVE);
});

test("plan capacity frees after enrolment expiry", async () => {
  const { tenant, branch, user } = await tenantWithPolicy(false);
  const customerA = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: `+9181${String(Date.now()).slice(-8)}`,
  });
  const customerB = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: `+9182${String(Date.now()).slice(-8)}`,
  });
  const plan = buildFixedPlan(tenant._id, "CAPFREE", {
    availability: { allBranches: true, maxEnrolments: 1, visibleInCustomerApp: true, customerSelfEnrolAllowed: true },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      firstInstallmentModeDefault: FirstInstallmentMode.COLLECT_NOW,
    },
    paymentRules: {
      partialPaymentAllowed: true,
      advancePaymentAllowed: false,
      minPaymentPaise: 100_000,
    },
  });
  await SchemePlan.create(plan);
  const enrolled = await enrol(enrolReq({
    tenant,
    branch,
    user,
    customerId: customerA._id,
    planId: plan._id,
    body: { firstInstallmentMode: FirstInstallmentMode.COLLECT_NOW },
  }));
  const paymentId = createId("payment");
  const intentId = createId("paymentIntent");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: enrolled._id,
    customerId: customerA._id,
    receiptNumber: `PENDING-${intentId}`,
    amountPaise: 100_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(),
  });
  await PaymentIntent.create({
    _id: intentId,
    tenantId: tenant._id,
    schemeId: enrolled._id,
    customerId: customerA._id,
    paymentId,
    amountPaise: 100_000,
    status: PaymentIntentStatus.PENDING,
    targetCycle: "2026-04",
    positionVersion: 1,
    reservationExpiresAt: new Date(Date.now() + 3600_000),
    version: 1,
  });
  await applyTerminalGatewayFailure({
    tenantId: tenant._id,
    paymentId,
    reference: intentId,
  });
  const occupied = await Scheme.countDocuments({
    tenantId: tenant._id,
    planId: plan._id,
    status: { $in: ENROLMENT_CAPACITY_STATUSES },
  });
  assert.equal(occupied, 0);
  const second = await enrol(enrolReq({
    tenant,
    branch,
    user,
    customerId: customerB._id,
    planId: plan._id,
    body: { firstInstallmentMode: FirstInstallmentMode.START_NEXT_CYCLE },
  }));
  assert.ok(second._id);
});

test("late gateway success after enrolment expiry routes to manual review once", async () => {
  const { tenant, branch, user } = await tenantWithPolicy(false);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const plan = buildFixedPlan(tenant._id, "LATEX", {
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      firstInstallmentModeDefault: FirstInstallmentMode.COLLECT_NOW,
    },
    paymentRules: {
      partialPaymentAllowed: true,
      advancePaymentAllowed: false,
      minPaymentPaise: 100_000,
    },
  });
  await SchemePlan.create(plan);
  const enrolled = await enrol(enrolReq({
    tenant,
    branch,
    user,
    customerId: customer._id,
    planId: plan._id,
    body: { firstInstallmentMode: FirstInstallmentMode.COLLECT_NOW },
  }));
  const paymentId = createId("payment");
  const intentId = createId("paymentIntent");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: enrolled._id,
    customerId: customer._id,
    receiptNumber: `PENDING-${intentId}`,
    amountPaise: 100_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(),
  });
  await PaymentIntent.create({
    _id: intentId,
    tenantId: tenant._id,
    schemeId: enrolled._id,
    customerId: customer._id,
    paymentId,
    amountPaise: 100_000,
    status: PaymentIntentStatus.PENDING,
    targetCycle: "2026-04",
    positionVersion: 1,
    reservationExpiresAt: new Date(Date.now() + 3600_000),
    version: 1,
  });
  await applyTerminalGatewayFailure({
    tenantId: tenant._id,
    paymentId,
    reference: intentId,
  });
  assert.equal((await Scheme.findById(enrolled._id).lean()).status, SchemeStatus.ENROLMENT_EXPIRED);
  const intent = await PaymentIntent.findById(intentId).lean();
  assert.equal(intent.status, PaymentIntentStatus.FAILED);
  assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.FAILED);
  const txId = `TX-${randomUUID()}`;
  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intentId,
    transactionId: txId,
    amountPaise: 100_000,
    intent,
    paymentId,
  });
  const pay = await Payment.findById(paymentId).lean();
  assert.equal(pay.status, PaymentStatus.UNALLOCATED_PENDING_REVIEW);
  assert.equal((await Scheme.findById(enrolled._id).lean()).status, SchemeStatus.ENROLMENT_EXPIRED);
  assert.equal(await Alert.countDocuments({ tenantId: tenant._id, entityId: paymentId, type: "PAYMENT_REVIEW" }), 1);
  assert.equal(
    await OutboxEvent.countDocuments({ tenantId: tenant._id, topic: "payment.unallocated.enrolment_expired", key: paymentId }),
    1,
  );
  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intentId,
    transactionId: txId,
    amountPaise: 100_000,
    intent,
    paymentId,
  });
  assert.equal(await Alert.countDocuments({ tenantId: tenant._id, entityId: paymentId, type: "PAYMENT_REVIEW" }), 1);
  assert.equal(
    await OutboxEvent.countDocuments({ tenantId: tenant._id, topic: "payment.unallocated.enrolment_expired", key: paymentId }),
    1,
  );
});
