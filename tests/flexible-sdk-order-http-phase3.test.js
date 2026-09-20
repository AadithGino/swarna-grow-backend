import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { monthKey } from "../src/lib/date.js";
import { buildFlexibleSchemeCycleRows } from "../src/lib/calendar-cycle.js";
import { finalizeGatewaySuccess } from "../src/services/finalize-gateway-success.service.js";
import {
  LedgerEntry,
  Payment,
  PaymentIntent,
  PaymentLink,
  Scheme,
  Session,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { signAccessToken } from "../src/services/token.service.js";
import { LedgerEntryType, TenantRole } from "../src/constants/enums.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();
const redirectUrl = "http://localhost:5173/pay/return";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function shiftMonth(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function seedFreePhaseScheme({ startDate, positionVersion = 0 } = {}) {
  const current = monthKey();
  const start = startDate ?? `${current}-01`;
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const durationMonths = 4;
  const freeCycles = 2;
  const cycles = buildFlexibleSchemeCycleRows({
    startDate: start,
    durationMonths,
    firstInstallmentMode: "COLLECT_NOW",
  });
  const flexRules = {
    flexiblePhaseCycles: freeCycles,
    cappedPhaseCycles: durationMonths - freeCycles,
    flexiblePhase: {
      minimumPaymentPaise: 10_000,
      maximumPaymentPaise: 2_500_000,
      paymentIncrementPaise: 1_000,
      minTotalPaise: 0,
      paymentsRequiredPerCycle: 0,
    },
    cappedPhase: {
      minimumPaymentPaise: 10_000,
      paymentIncrementPaise: 1_000,
      allowFinalRemainderBelowMinimum: true,
      allowFutureCyclePayment: false,
      maxAdvanceCycles: 0,
    },
  };
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-SDK-${Date.now()}`,
    planSnapshot: { paymentPattern: "FLEXIBLE", flexibleRules: flexRules },
    valueBasis: "CASH",
    paymentPattern: "FLEXIBLE",
    status: "ACTIVE",
    flexiblePhase: "FLEXIBLE",
    startDate: start,
    maturityDate: cycles.at(-1).expiresAt,
    cycles,
    positionVersion,
    ledgerNextSequence: 0,
    createdBy: user._id,
  });
  return { tenant, customer, scheme };
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

function sdkOrderBody(scheme, extra = {}) {
  return {
    amountPaise: 25_000,
    redirectUrl,
    expectedPositionVersion: scheme.positionVersion ?? 0,
    ...extra,
  };
}

async function postSdkOrder(token, schemeId, { query = {}, body } = {}) {
  return request(app)
    .post(`/api/v1/app/schemes/${schemeId}/pay/sdk-order`)
    .query(query)
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", randomUUID())
    .send(body);
}

async function assertNoPaymentArtifacts(schemeId) {
  assert.equal(await PaymentLink.countDocuments({ schemeId }), 0);
  assert.equal(await PaymentIntent.countDocuments({ schemeId }), 0);
  assert.equal(await Payment.countDocuments({ schemeId }), 0);
  assert.equal(await LedgerEntry.countDocuments({ schemeId }), 0);
}

test("SDK order stores authoritative current free-phase cycle", async () => {
  const current = monthKey();
  const { tenant, customer, scheme } = await seedFreePhaseScheme();
  const token = await customerBearer({ tenant, customer });
  const response = await postSdkOrder(token, scheme._id, { body: sdkOrderBody(scheme) });
  assert.equal(response.status, 201);
  assert.ok(response.body.data.token ?? response.body.data.providerOrderId);
  const intent = await PaymentIntent.findOne({ schemeId: scheme._id }).lean();
  const payment = await Payment.findOne({ schemeId: scheme._id }).lean();
  assert.equal(intent.targetCycle, current);
  assert.equal(payment.targetCycle, current);
});

test("SDK order rejects past targetCycle in body", async () => {
  const current = monthKey();
  const past = shiftMonth(current, -1);
  const { tenant, customer, scheme } = await seedFreePhaseScheme();
  const token = await customerBearer({ tenant, customer });
  const response = await postSdkOrder(token, scheme._id, {
    body: sdkOrderBody(scheme, { targetCycle: past }),
  });
  assert.equal(response.body.error?.code, "INVALID_PAYMENT_CYCLE");
  await assertNoPaymentArtifacts(scheme._id);
});

test("SDK order rejects future targetCycle in body", async () => {
  const current = monthKey();
  const future = shiftMonth(current, 1);
  const { tenant, customer, scheme } = await seedFreePhaseScheme();
  const token = await customerBearer({ tenant, customer });
  const response = await postSdkOrder(token, scheme._id, {
    body: sdkOrderBody(scheme, { targetCycle: future }),
  });
  assert.equal(response.body.error?.code, "INVALID_PAYMENT_CYCLE");
  await assertNoPaymentArtifacts(scheme._id);
});

test("SDK order rejects nonexistent targetCycle", async () => {
  const { tenant, customer, scheme } = await seedFreePhaseScheme();
  const token = await customerBearer({ tenant, customer });
  const response = await postSdkOrder(token, scheme._id, {
    body: sdkOrderBody(scheme, { targetCycle: "2099-13" }),
  });
  assert.equal(response.body.error?.code, "INVALID_PAYMENT_CYCLE");
  await assertNoPaymentArtifacts(scheme._id);
});

test("SDK order rejects past targetCycle in query", async () => {
  const current = monthKey();
  const past = shiftMonth(current, -1);
  const { tenant, customer, scheme } = await seedFreePhaseScheme();
  const token = await customerBearer({ tenant, customer });
  const response = await postSdkOrder(token, scheme._id, {
    query: { targetCycle: past },
    body: sdkOrderBody(scheme),
  });
  assert.equal(response.body.error?.code, "INVALID_PAYMENT_CYCLE");
  await assertNoPaymentArtifacts(scheme._id);
});

test("SDK order ignores body targetCycle when query supplies authoritative cycle", async () => {
  const current = monthKey();
  const past = shiftMonth(current, -1);
  const { tenant, customer, scheme } = await seedFreePhaseScheme();
  const token = await customerBearer({ tenant, customer });
  const response = await postSdkOrder(token, scheme._id, {
    query: { targetCycle: current },
    body: sdkOrderBody(scheme, { targetCycle: past }),
  });
  assert.equal(response.status, 201);
  const intent = await PaymentIntent.findOne({ schemeId: scheme._id }).lean();
  const payment = await Payment.findOne({ schemeId: scheme._id }).lean();
  assert.equal(intent.targetCycle, current);
  assert.equal(payment.targetCycle, current);
  assert.notEqual(intent.targetCycle, past);
});

test("SDK order finalization uses intent cycle when payment row is tampered", async () => {
  const current = monthKey();
  const tampered = shiftMonth(current, -1);
  const { tenant, customer, scheme } = await seedFreePhaseScheme();
  const token = await customerBearer({ tenant, customer });
  const created = await postSdkOrder(token, scheme._id, { body: sdkOrderBody(scheme) });
  assert.equal(created.status, 201);
  const intent = await PaymentIntent.findOne({ schemeId: scheme._id }).lean();
  const paymentId = intent.paymentId;
  await Payment.updateOne({ _id: paymentId }, { $set: { targetCycle: tampered } });
  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent._id,
    transactionId: `TX-${createId("tx")}`,
    amountPaise: 25_000,
    intent,
    paymentId,
  });
  const entry = await LedgerEntry.findOne({ schemeId: scheme._id, paymentId }).lean();
  assert.equal(entry.type, LedgerEntryType.FREE_WINDOW_PAYMENT);
  assert.equal(entry.cycle, current);
});

test("SDK gateway callback replay is idempotent", async () => {
  const { tenant, customer, scheme } = await seedFreePhaseScheme();
  const token = await customerBearer({ tenant, customer });
  const created = await postSdkOrder(token, scheme._id, { body: sdkOrderBody(scheme) });
  assert.equal(created.status, 201);
  const intent = await PaymentIntent.findOne({ schemeId: scheme._id }).lean();
  const paymentId = intent.paymentId;
  const transactionId = intent.providerOrderId ?? `TX-${createId("tx")}`;
  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent._id,
    transactionId,
    amountPaise: 25_000,
    intent,
    paymentId,
  });
  const replay = await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent._id,
    transactionId,
    amountPaise: 25_000,
    intent,
    paymentId,
  });
  assert.equal(replay.outcome, "ALREADY_SUCCESS");
  assert.equal(await LedgerEntry.countDocuments({ schemeId: scheme._id, paymentId }), 1);
  assert.equal(await Payment.countDocuments({ schemeId: scheme._id, status: "SUCCESS" }), 1);
});
