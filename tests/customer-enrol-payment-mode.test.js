import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { phonePeProvider } from "../src/integrations/phonepe.provider.js";
import { IdempotencyRecord, Payment, PaymentIntent, Scheme, SchemePlan, Session, Tenant } from "../src/models/index.js";
import { withTransaction } from "../src/lib/transaction.js";
import { createEnrolmentInSession, validateEnrolment } from "../src/services/scheme.service.js";
import { createId } from "../src/lib/ids.js";
import { signAccessToken } from "../src/services/token.service.js";
import { sha256 } from "../src/lib/crypto.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const stableBody = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableBody).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableBody(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const app = createApp();
const redirectUrl = "http://localhost:5173/pay/return";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function growthTenantWithPaymentsDisabled() {
  const seeded = await seedTenantUser({});
  await Tenant.updateOne(
    { _id: seeded.tenant._id },
    {
      $set: {
        "subscription.tier": "GROWTH",
        "operations.customerAppPaymentsEnabled": false,
      },
    },
  );
  const tenant = await Tenant.findById(seeded.tenant._id).lean();
  return { ...seeded, tenant };
}

async function seedFlexibleCollectNowPlan(tenantId) {
  const planId = createId("schemePlan");
  await SchemePlan.create({
    _id: planId,
    tenantId,
    name: "Flex self enrol",
    code: `FSEL${String(Math.random()).slice(2, 5)}`,
    status: "ACTIVE",
    paymentPattern: "FLEXIBLE",
    valueBasis: "CASH",
    durationMonths: 11,
    installmentCount: 11,
    amountRules: {
      amountMode: "CUSTOMER_CHOSEN",
      minInstallmentPaise: 100_000,
      maxInstallmentPaise: 2_500_000,
      multipleOfPaise: 10_000,
    },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      firstInstallmentModeDefault: "COLLECT_NOW",
      firstInstallmentModeEditable: false,
    },
    paymentRules: {
      partialPaymentAllowed: true,
      advancePaymentAllowed: false,
      minPaymentPaise: 100_000,
    },
    redemptionRules: {
      prematureClosureAllowed: false,
      lockInMonths: 0,
      prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
      allowedModes: ["CASH"],
      redeemAtAnyBranch: false,
    },
    benefit: {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "FLAT",
      bonusValue: 50_000,
      displayLabel: "Bonus",
      eligibility: {
        requireAllInstallmentsPaid: true,
        maxAllowedDefaults: 0,
        minMonthsCompleted: 0,
      },
    },
    version: 1,
    availability: {
      allBranches: true,
      branchIds: [],
      visibleInCustomerApp: true,
      customerSelfEnrolAllowed: true,
    },
    flexibleRules: {
      phaseMode: "FLEXIBLE_THEN_CAPPED",
      capMode: "FLEXIBLE_PHASE_AVERAGE",
      carryForwardMode: "NONE",
      flexiblePhaseCycles: 6,
      cappedPhaseCycles: 5,
      averagingDivisor: 6,
      frequencyMode: "MULTIPLE",
      flexiblePhase: {
        minimumPaymentPaise: 100_000,
        maximumPaymentPaise: 2_500_000,
        paymentIncrementPaise: 10_000,
        minTotalPaise: 300_000,
        paymentsRequiredPerCycle: 0,
      },
      capComputation: {
        formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
        roundingMode: "ROUND_UP",
        roundToNearestPaise: 10_000,
        minCycleCapPaise: 50_000,
        maxCycleCapPaise: 10_000_000,
        onZeroFlexiblePhaseTotal: "CLOSE_SCHEME",
        onBelowMinimumTotal: "USE_MINIMUM",
      },
      cappedPhase: {
        minimumPaymentPaise: 100_000,
        paymentIncrementPaise: 10_000,
        allowFinalRemainderBelowMinimum: true,
        allowFutureCyclePayment: false,
        maxAdvanceCycles: 0,
      },
    },
  });
  return planId;
}

async function seedSelfEnrolPlan(tenantId, scheduleRules, paymentPattern = "FIXED") {
  const planId = createId("schemePlan");
  const base = {
    _id: planId,
    tenantId,
    name: "Self enrol plan",
    code: `SELP${String(Math.random()).slice(2, 6)}`,
    status: "ACTIVE",
    paymentPattern,
    valueBasis: "CASH",
    durationMonths: 12,
    installmentCount: 12,
    amountRules: {
      amountMode: paymentPattern === "FLEXIBLE" ? "CUSTOMER_CHOSEN" : "JEWELLER_FIXED",
      fixedAmountPaise: 100_000,
      minInstallmentPaise: 100_000,
      maxInstallmentPaise: 2_500_000,
      multipleOfPaise: 10_000,
    },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      ...scheduleRules,
    },
    paymentRules: {
      partialPaymentAllowed: false,
      minPaymentPaise: 100_000,
    },
    redemptionRules: {
      prematureClosureAllowed: false,
      lockInMonths: 0,
      prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
      allowedModes: ["CASH"],
      redeemAtAnyBranch: false,
    },
    benefit: {
      type: "TEXT_ONLY",
      displayLabel: "Benefit",
      eligibility: {
        requireAllInstallmentsPaid: true,
        maxAllowedDefaults: 0,
        minMonthsCompleted: 0,
      },
    },
    version: 1,
    availability: {
      allBranches: true,
      branchIds: [],
      visibleInCustomerApp: true,
      customerSelfEnrolAllowed: true,
    },
  };
  if (paymentPattern === "FLEXIBLE") {
    Object.assign(base, {
      flexibleRules: {
        phaseMode: "FLEXIBLE_THEN_CAPPED",
        capMode: "FLEXIBLE_PHASE_AVERAGE",
        carryForwardMode: "NONE",
        flexiblePhaseCycles: 6,
        cappedPhaseCycles: 5,
        averagingDivisor: 6,
        frequencyMode: "MULTIPLE",
        flexiblePhase: {
          minimumPaymentPaise: 100_000,
          maximumPaymentPaise: 2_500_000,
          paymentIncrementPaise: 10_000,
          minTotalPaise: 300_000,
          paymentsRequiredPerCycle: 0,
        },
        capComputation: {
          formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
          roundingMode: "ROUND_UP",
          roundToNearestPaise: 10_000,
          minCycleCapPaise: 50_000,
          maxCycleCapPaise: 10_000_000,
          onZeroFlexiblePhaseTotal: "CLOSE_SCHEME",
          onBelowMinimumTotal: "USE_MINIMUM",
        },
        cappedPhase: {
          minimumPaymentPaise: 100_000,
          paymentIncrementPaise: 10_000,
          allowFinalRemainderBelowMinimum: true,
          allowFutureCyclePayment: false,
          maxAdvanceCycles: 0,
        },
      },
    });
  }
  await SchemePlan.create(base);
  return planId;
}

async function customerBearer({ tenant, customer }) {
  const session = await Session.create({
    _id: createId("session"),
    customerId: customer._id,
    tenantId: tenant._id,
    deviceId: "test-device",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "android",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return signAccessToken({
    id: customer._id,
    type: "CUSTOMER",
    tenantId: tenant._id,
    branchId: customer.branchId,
    role: "CUSTOMER",
    permissions: [],
    deviceId: "test-device",
    securityVersion: customer.securityVersion ?? 0,
    sessionId: session._id,
  });
}

async function enrolRequest({ token, body, idempotencyKey = randomUUID() }) {
  return request(app)
    .post("/api/v1/app/schemes/enrol")
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", idempotencyKey)
    .send(body);
}

test("omitted payNow + START_NEXT_CYCLE default succeeds with payments disabled", async () => {
  const { tenant, branch } = await growthTenantWithPaymentsDisabled();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const planId = await seedSelfEnrolPlan(tenant._id, {
    firstInstallmentModeDefault: "START_NEXT_CYCLE",
    firstInstallmentModeEditable: true,
  });
  const token = await customerBearer({ tenant, customer });
  const res = await enrolRequest({
    token,
    body: { planId, installmentAmountPaise: 100_000 },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.success, true);
  const scheme = await Scheme.findOne({ tenantId: tenant._id, customerId: customer._id }).lean();
  assert.equal(scheme.status, "ACTIVE");
  assert.equal(await Payment.countDocuments({ tenantId: tenant._id }), 0);
  assert.equal(await PaymentIntent.countDocuments({ tenantId: tenant._id }), 0);
});

test("explicit payNow false on editable plan succeeds with payments disabled", async () => {
  const { tenant, branch } = await growthTenantWithPaymentsDisabled();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const planId = await seedSelfEnrolPlan(tenant._id, {
    firstInstallmentModeDefault: "COLLECT_NOW",
    firstInstallmentModeEditable: true,
  });
  const token = await customerBearer({ tenant, customer });
  const res = await enrolRequest({
    token,
    body: { planId, installmentAmountPaise: 100_000, payNow: false },
  });
  assert.equal(res.status, 201);
  const scheme = await Scheme.findOne({ tenantId: tenant._id, customerId: customer._id }).lean();
  assert.equal(scheme.status, "ACTIVE");
  assert.equal(await Payment.countDocuments({ tenantId: tenant._id }), 0);
});

test("COLLECT_NOW enrol rejects before scheme when payments disabled", async () => {
  const { tenant, branch } = await growthTenantWithPaymentsDisabled();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const planId = await seedSelfEnrolPlan(tenant._id, {
    firstInstallmentModeDefault: "COLLECT_NOW",
    firstInstallmentModeEditable: true,
  });
  const token = await customerBearer({ tenant, customer });

  for (const body of [
    { planId, installmentAmountPaise: 100_000, redirectUrl },
    { planId, installmentAmountPaise: 100_000, payNow: true, redirectUrl },
  ]) {
    const res = await enrolRequest({ token, body });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "CUSTOMER_PAYMENTS_DISABLED");
  }
  assert.equal(await Scheme.countDocuments({ tenantId: tenant._id }), 0);
  assert.equal(await Payment.countDocuments({ tenantId: tenant._id }), 0);
});

test("locked COLLECT_NOW rejects payNow false before creation", async () => {
  const { tenant, branch } = await growthTenantWithPaymentsDisabled();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const planId = await seedSelfEnrolPlan(tenant._id, {
    firstInstallmentModeDefault: "COLLECT_NOW",
    firstInstallmentModeEditable: false,
  });
  const token = await customerBearer({ tenant, customer });
  const res = await enrolRequest({
    token,
    body: { planId, installmentAmountPaise: 100_000, payNow: false },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, "FIRST_INSTALLMENT_MODE_LOCKED");
  assert.equal(await Scheme.countDocuments({ tenantId: tenant._id }), 0);
});

test("locked START_NEXT_CYCLE rejects payNow true before creation", async () => {
  const { tenant, branch } = await growthTenantWithPaymentsDisabled();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const planId = await seedSelfEnrolPlan(tenant._id, {
    firstInstallmentModeDefault: "START_NEXT_CYCLE",
    firstInstallmentModeEditable: false,
  });
  const token = await customerBearer({ tenant, customer });
  const res = await enrolRequest({
    token,
    body: { planId, installmentAmountPaise: 100_000, payNow: true, redirectUrl },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, "FIRST_INSTALLMENT_MODE_LOCKED");
  assert.equal(await Scheme.countDocuments({ tenantId: tenant._id }), 0);
});

test("in-tx plan flip to COLLECT_NOW rejects when payments disabled", async () => {
  const { tenant, branch } = await growthTenantWithPaymentsDisabled();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const planId = await seedSelfEnrolPlan(tenant._id, {
    firstInstallmentModeDefault: "START_NEXT_CYCLE",
    firstInstallmentModeEditable: false,
  });
  const req = {
    auth: { id: customer._id, tenantId: tenant._id, type: "CUSTOMER" },
    scope: { tenantId: tenant._id },
    tenant,
    headers: {},
    ip: "127.0.0.1",
    baseUrl: "/app",
    body: { planId, installmentAmountPaise: 100_000 },
  };
  const validation = await validateEnrolment(req);
  await SchemePlan.updateOne(
    { _id: planId },
    { $set: { "scheduleRules.firstInstallmentModeDefault": "COLLECT_NOW" }, $inc: { version: 1 } },
  );
  await assert.rejects(
    () => withTransaction((session) => createEnrolmentInSession(req, validation, session)),
    (error) => error.code === "CUSTOMER_PAYMENTS_DISABLED",
  );
  assert.equal(await Scheme.countDocuments({ tenantId: tenant._id }), 0);
});

test("legacy PAYMENT_INIT_FAILED idempotency record is repaired on retry", async () => {
  const { tenant, branch } = await seedTenantUser({});
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "subscription.tier": "GROWTH", "operations.customerAppPaymentsEnabled": true } },
  );
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const planId = await seedFlexibleCollectNowPlan(tenant._id);
  const token = await customerBearer({ tenant, customer });
  const idempotencyKey = randomUUID();
  const body = { planId, installmentAmountPaise: 100_000, redirectUrl };
  await IdempotencyRecord.create({
    tenantId: tenant._id,
    actorId: customer._id,
    endpoint: "POST /schemes/enrol",
    key: idempotencyKey,
    bodyHash: sha256(stableBody(body)),
    state: "COMPLETED",
    responseStatus: 422,
    responseBody: {
      success: false,
      error: { code: "PAYMENT_INIT_FAILED", message: "old" },
    },
    expiresAt: new Date(Date.now() + 86_400_000),
  });

  const res = await enrolRequest({ token, body, idempotencyKey });
  assert.equal(res.status, 201);
  assert.equal(res.body.success, true);
  assert.equal(await IdempotencyRecord.countDocuments({ tenantId: tenant._id, key: idempotencyKey, state: "COMPLETED", responseStatus: 422 }), 0);
});

test("concurrent enrol retries share one pending scheme after provider failure", async () => {
  const { tenant, branch } = await seedTenantUser({});
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "subscription.tier": "GROWTH", "operations.customerAppPaymentsEnabled": true } },
  );
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const planId = await seedFlexibleCollectNowPlan(tenant._id);
  const token = await customerBearer({ tenant, customer });
  const idempotencyKey = randomUUID();
  const body = { planId, installmentAmountPaise: 100_000, redirectUrl };

  const originalCreatePayment = phonePeProvider.createPayment.bind(phonePeProvider);
  let createCalls = 0;
  phonePeProvider.createPayment = async (args) => {
    createCalls += 1;
    if (createCalls === 1) throw new Error("PhonePe initiation unavailable");
    return originalCreatePayment(args);
  };

  try {
    const first = await enrolRequest({ token, body, idempotencyKey });
    assert.ok(first.status >= 500, `expected 5xx, got ${first.status}`);
    assert.equal(first.body.error.code, "DEPENDENCY_UNAVAILABLE");

    const [retryA, retryB] = await Promise.all([
      enrolRequest({ token, body, idempotencyKey }),
      enrolRequest({ token, body, idempotencyKey }),
    ]);
    const successCount = [retryA, retryB].filter((res) => res.status === 201).length;
    assert.ok(successCount >= 1);
    assert.ok(retryA.status === 201 || retryA.status === 409 || retryA.status >= 500);
    assert.ok(retryB.status === 201 || retryB.status === 409 || retryB.status >= 500);

    assert.equal(await Scheme.countDocuments({ tenantId: tenant._id, customerId: customer._id }), 1);
    assert.equal(await PaymentIntent.countDocuments({ tenantId: tenant._id, customerId: customer._id }), 1);
    assert.equal(createCalls, 2);
  } finally {
    phonePeProvider.createPayment = originalCreatePayment;
  }
});
