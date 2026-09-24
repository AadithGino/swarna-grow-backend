import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { phonePeProvider } from "../src/integrations/phonepe.provider.js";
import { Payment, PaymentIntent, Scheme, SchemePlan, Session, Tenant } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { signAccessToken } from "../src/services/token.service.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();
const redirectUrl = "http://localhost:5173/pay/return";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function seedFlexibleSelfEnrolPlan(tenantId) {
  const planId = createId("schemePlan");
  await SchemePlan.create({
    _id: planId,
    tenantId,
    name: "Flex self enrol",
    code: "FSEL",
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

test("idempotent customer enrol retries PhonePe on existing pending checkout after initiation failure", async () => {
  const { tenant, branch } = await seedTenantUser({});
  await Tenant.updateOne({ _id: tenant._id }, { $set: { "subscription.tier": "GROWTH" } });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const planId = await seedFlexibleSelfEnrolPlan(tenant._id);
  const token = await customerBearer({ tenant, customer });
  const idempotencyKey = randomUUID();
  const body = {
    planId,
    installmentAmountPaise: 100_000,
    redirectUrl,
  };

  const originalCreatePayment = phonePeProvider.createPayment.bind(phonePeProvider);
  let createCalls = 0;
  phonePeProvider.createPayment = async (args) => {
    createCalls += 1;
    if (createCalls === 1) throw new Error("PhonePe initiation unavailable");
    return originalCreatePayment(args);
  };

  try {
    const failed = await request(app)
      .post("/api/v1/app/schemes/enrol")
      .set("authorization", `Bearer ${token}`)
      .set("x-idempotency-key", idempotencyKey)
      .send(body);
    assert.ok(failed.status >= 500, `expected provider failure, got ${failed.status}`);

    assert.equal(await Scheme.countDocuments({ tenantId: tenant._id, customerId: customer._id }), 1);
    assert.equal(await PaymentIntent.countDocuments({ tenantId: tenant._id, customerId: customer._id }), 1);
    assert.equal(await Payment.countDocuments({ tenantId: tenant._id, customerId: customer._id, status: "PENDING" }), 1);

    const schemeBefore = await Scheme.findOne({ tenantId: tenant._id, customerId: customer._id }).lean();
    const intentBefore = await PaymentIntent.findOne({ tenantId: tenant._id, schemeId: schemeBefore._id }).lean();

    const retry = await request(app)
      .post("/api/v1/app/schemes/enrol")
      .set("authorization", `Bearer ${token}`)
      .set("x-idempotency-key", idempotencyKey)
      .send(body);

    assert.equal(retry.status, 201);
    assert.equal(retry.body.success, true);
    assert.equal(retry.body.data.paymentType, "FLEXIBLE_PAYMENT_INTENT");
    assert.ok(retry.body.data.paymentIntent?.paymentUrl);

    assert.equal(await Scheme.countDocuments({ tenantId: tenant._id, customerId: customer._id }), 1);
    assert.equal(await PaymentIntent.countDocuments({ tenantId: tenant._id, customerId: customer._id }), 1);
    assert.equal(await Payment.countDocuments({ tenantId: tenant._id, customerId: customer._id, status: "PENDING" }), 1);
    assert.equal(createCalls, 2);

    const intentAfter = await PaymentIntent.findById(intentBefore._id).lean();
    assert.equal(intentAfter.status, "PENDING");
    assert.ok(intentAfter.providerOrderId);
    assert.equal(String(intentAfter.schemeId), String(schemeBefore._id));
  } finally {
    phonePeProvider.createPayment = originalCreatePayment;
  }
});
