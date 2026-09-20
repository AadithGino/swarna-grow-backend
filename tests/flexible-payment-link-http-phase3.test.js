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
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

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

async function seedFreePhaseScheme({ startDate, freeCycles = 2, durationMonths = 4, positionVersion = 0 } = {}) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const cycles = buildFlexibleSchemeCycleRows({
    startDate,
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
    enrollmentNumber: `ENR-PLK-${Date.now()}`,
    planSnapshot: { paymentPattern: "FLEXIBLE", flexibleRules: flexRules },
    valueBasis: "CASH",
    paymentPattern: "FLEXIBLE",
    status: "ACTIVE",
    flexiblePhase: "FLEXIBLE",
    startDate,
    maturityDate: cycles.at(-1).expiresAt,
    cycles,
    positionVersion,
    ledgerNextSequence: 0,
    createdBy: user._id,
  });
  return { tenant, branch, user, customer, scheme, cycles, flexRules };
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

function adminLinkBody(schemeId, { amountPaise = 25_000, targetCycle, expectedPositionVersion = 0 } = {}) {
  const body = {
    schemeId,
    amountPaise,
    expectedPositionVersion,
  };
  if (targetCycle !== undefined) body.targetCycle = targetCycle;
  return body;
}

async function postAdminPaymentLink(token, body) {
  return request(app)
    .post("/api/v1/admin/payment-links")
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", randomUUID())
    .send(body);
}

async function postPublicInitiate(linkToken, { query = {}, body = { redirectUrl } } = {}) {
  return request(app)
    .post(`/api/v1/public/pay/${linkToken}/initiate`)
    .query(query)
    .set("x-idempotency-key", randomUUID())
    .send(body);
}

function intentBody(scheme, amountPaise = 25_000) {
  return {
    amountPaise,
    redirectUrl,
    expectedPositionVersion: scheme.positionVersion ?? 0,
  };
}

async function assertNoPaymentArtifacts(schemeId) {
  assert.equal(await PaymentLink.countDocuments({ schemeId }), 0);
  assert.equal(await PaymentIntent.countDocuments({ schemeId }), 0);
  assert.equal(await Payment.countDocuments({ schemeId }), 0);
  assert.equal(await LedgerEntry.countDocuments({ schemeId }), 0);
}

test("admin payment link rejects past free-phase targetCycle", async () => {
  const current = monthKey();
  const past = shiftMonth(current, -1);
  const { scheme, user } = await seedFreePhaseScheme({ startDate: `${current}-01` });
  const token = bearerFor(user);
  const response = await postAdminPaymentLink(token, adminLinkBody(scheme._id, { targetCycle: past }));
  assert.equal(response.body.error?.code, "INVALID_PAYMENT_CYCLE");
  await assertNoPaymentArtifacts(scheme._id);
});

test("admin payment link rejects future free-phase targetCycle", async () => {
  const current = monthKey();
  const future = shiftMonth(current, 1);
  const { scheme, user } = await seedFreePhaseScheme({ startDate: `${current}-01` });
  const token = bearerFor(user);
  const response = await postAdminPaymentLink(token, adminLinkBody(scheme._id, { targetCycle: future }));
  assert.equal(response.body.error?.code, "INVALID_PAYMENT_CYCLE");
  await assertNoPaymentArtifacts(scheme._id);
});

test("admin payment link rejects nonexistent targetCycle", async () => {
  const current = monthKey();
  const { scheme, user } = await seedFreePhaseScheme({ startDate: `${current}-01` });
  const token = bearerFor(user);
  const response = await postAdminPaymentLink(token, adminLinkBody(scheme._id, { targetCycle: "2099-13" }));
  assert.equal(response.body.error?.code, "INVALID_PAYMENT_CYCLE");
  await assertNoPaymentArtifacts(scheme._id);
});

test("admin payment link stores authoritative current cycle", async () => {
  const current = monthKey();
  const { scheme, user } = await seedFreePhaseScheme({ startDate: `${current}-01` });
  const token = bearerFor(user);
  const response = await postAdminPaymentLink(token, adminLinkBody(scheme._id));
  assert.equal(response.status, 201);
  const link = await PaymentLink.findOne({ schemeId: scheme._id }).lean();
  const intent = await PaymentIntent.findOne({ schemeId: scheme._id }).lean();
  assert.equal(link.targetCycle, current);
  assert.equal(intent.targetCycle, current);
  assert.ok(response.body.data.token);
});

test("public initiate ignores tampered targetCycle on body and query", async () => {
  const current = monthKey();
  const tampered = shiftMonth(current, -1);
  const { scheme, user } = await seedFreePhaseScheme({ startDate: `${current}-01` });
  const adminToken = bearerFor(user);
  const firstLink = await postAdminPaymentLink(adminToken, adminLinkBody(scheme._id, { expectedPositionVersion: 0 }));
  assert.equal(firstLink.status, 201);
  const strippedBody = await postPublicInitiate(firstLink.body.data.token, {
    body: { redirectUrl, targetCycle: tampered },
  });
  assert.equal(strippedBody.status, 200);
  assert.equal((await Payment.findById(strippedBody.body.data.paymentId).lean()).targetCycle, current);
  const refreshedScheme = await Scheme.findById(scheme._id).lean();
  const secondLink = await postAdminPaymentLink(
    adminToken,
    adminLinkBody(scheme._id, { expectedPositionVersion: refreshedScheme.positionVersion }),
  );
  const initiate = await postPublicInitiate(secondLink.body.data.token, {
    query: { targetCycle: tampered },
  });
  assert.equal(initiate.status, 200);
  const payment = await Payment.findById(initiate.body.data.paymentId).lean();
  assert.equal(payment.targetCycle, current);
  assert.notEqual(payment.targetCycle, tampered);
});

test("public initiate replay does not create duplicate payments", async () => {
  const current = monthKey();
  const { scheme, user } = await seedFreePhaseScheme({ startDate: `${current}-01` });
  const adminToken = bearerFor(user);
  const created = await postAdminPaymentLink(adminToken, adminLinkBody(scheme._id));
  const linkToken = created.body.data.token;
  const first = await postPublicInitiate(linkToken);
  assert.equal(first.status, 200);
  const second = await postPublicInitiate(linkToken);
  assert.equal(second.status, 200);
  assert.equal(second.body.data.paymentId, first.body.data.paymentId);
  assert.equal(await Payment.countDocuments({ schemeId: scheme._id }), 1);
});

test("gateway finalization on public link uses reserved link cycle", async () => {
  const current = monthKey();
  const tampered = shiftMonth(current, -1);
  const { tenant, scheme, user } = await seedFreePhaseScheme({ startDate: `${current}-01` });
  const adminToken = bearerFor(user);
  const created = await postAdminPaymentLink(adminToken, adminLinkBody(scheme._id));
  const linkToken = created.body.data.token;
  const initiated = await postPublicInitiate(linkToken);
  const paymentId = initiated.body.data.paymentId;
  const link = await PaymentLink.findOne({ schemeId: scheme._id }).lean();
  const intent = link.paymentIntentId
    ? await PaymentIntent.findById(link.paymentIntentId).lean()
    : null;
  await Payment.updateOne({ _id: paymentId }, { $set: { targetCycle: tampered } });
  const transactionId = `TX-${createId("tx")}`;
  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent?._id ?? link._id,
    transactionId,
    amountPaise: 25_000,
    intent: intent ?? undefined,
    paymentId,
  });
  const entry = await LedgerEntry.findOne({ schemeId: scheme._id, paymentId }).lean();
  assert.equal(entry.type, LedgerEntryType.FREE_WINDOW_PAYMENT);
  assert.equal(entry.cycle, current);
  assert.equal(await LedgerEntry.countDocuments({ schemeId: scheme._id, paymentId }), 1);
  const replay = await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent?._id ?? link._id,
    transactionId,
    amountPaise: 25_000,
    intent: intent ?? undefined,
    paymentId,
  });
  assert.equal(replay.outcome, "ALREADY_SUCCESS");
  assert.equal(await LedgerEntry.countDocuments({ schemeId: scheme._id, paymentId }), 1);
  assert.equal(await Payment.countDocuments({ schemeId: scheme._id, status: "SUCCESS" }), 1);
});

test("customer payment intent rejects invalid targetCycle over HTTP", async () => {
  const current = monthKey();
  const past = shiftMonth(current, -1);
  const { tenant, customer, scheme } = await seedFreePhaseScheme({ startDate: `${current}-01` });
  const token = await customerBearer({ tenant, customer });
  const response = await request(app)
    .post(`/api/v1/app/schemes/${scheme._id}/payment-intents`)
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", randomUUID())
    .send({ ...intentBody(scheme), targetCycle: past });
  assert.equal(response.body.error?.code, "INVALID_PAYMENT_CYCLE");
  await assertNoPaymentArtifacts(scheme._id);
});

test("customer payment intent stores authoritative current cycle", async () => {
  const current = monthKey();
  const { tenant, customer, scheme } = await seedFreePhaseScheme({ startDate: `${current}-01` });
  const token = await customerBearer({ tenant, customer });
  const response = await request(app)
    .post(`/api/v1/app/schemes/${scheme._id}/payment-intents`)
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", randomUUID())
    .send(intentBody(scheme));
  assert.equal(response.status, 201);
  const intent = await PaymentIntent.findOne({ schemeId: scheme._id }).lean();
  const payment = await Payment.findOne({ schemeId: scheme._id }).lean();
  assert.equal(intent.targetCycle, current);
  assert.equal(payment.targetCycle, current);
});

test("PhonePe finalization uses intent cycle when payment row is tampered", async () => {
  const current = monthKey();
  const tampered = shiftMonth(current, -1);
  const { tenant, customer, scheme } = await seedFreePhaseScheme({ startDate: `${current}-01` });
  const token = await customerBearer({ tenant, customer });
  const created = await request(app)
    .post(`/api/v1/app/schemes/${scheme._id}/payment-intents`)
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", randomUUID())
    .send(intentBody(scheme));
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
  assert.equal(entry.cycle, current);
});
