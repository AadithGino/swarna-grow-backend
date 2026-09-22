import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  PaymentMode,
  PaymentStatus,
} from "../src/constants/enums.js";
import { phonePeProvider } from "../src/integrations/phonepe.provider.js";
import { Alert, LedgerEntry, OutboxEvent, Payment, PaymentIntent } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import {
  seedAdminGatewayContext,
  seedBranchManagerContext,
} from "./helpers/gateway-http-fixture.js";
import { resetTestDb, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function poll(token, paymentId, idempotencyKey = "poll-idem-1") {
  return request(app)
    .post(`/api/v1/admin/payments/${paymentId}/poll-status`)
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", idempotencyKey)
    .send({});
}

test("poll-status returns stable DTO for finalized payment", async () => {
  const ctx = await seedAdminGatewayContext();
  await Payment.updateOne({ _id: ctx.paymentId }, { $set: { status: PaymentStatus.SUCCESS } });
  const res = await poll(ctx.token, ctx.paymentId);
  assert.equal(res.status, 200);
  assert.ok("outcome" in res.body.data);
  assert.ok("providerState" in res.body.data);
  assert.ok("requiresReview" in res.body.data);
  assert.equal(res.body.data.outcome, "ALREADY_TERMINAL");
});

test("branch manager scope and staff forbidden", async () => {
  const { ownerCtx, otherPayment, manager } = await seedBranchManagerContext();
  await Payment.updateOne({ _id: ownerCtx.paymentId }, { $set: { status: PaymentStatus.SUCCESS } });
  assert.equal((await poll(manager.token, ownerCtx.paymentId, "poll-bm-ok")).status, 200);
  assert.equal((await poll(manager.token, otherPayment.paymentId, "poll-bm-deny")).status, 404);
  const unauth = await request(app)
    .post(`/api/v1/admin/payments/${ownerCtx.paymentId}/poll-status`)
    .set("x-idempotency-key", "poll-unauth-123456")
    .send({});
  assert.equal(unauth.status, 401);
});

test("missing provider reference returns controlled error", async () => {
  const ctx = await seedAdminGatewayContext();
  await Payment.updateOne({ _id: ctx.paymentId }, { $set: { status: PaymentStatus.PENDING } });
  await PaymentIntent.deleteMany({ paymentId: ctx.paymentId });
  const res = await poll(ctx.token, ctx.paymentId, "poll-no-ref");
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, "POLL_STATUS_NO_REFERENCE");
});

test("provider transient error returns 503 without raw stack", async () => {
  const ctx = await seedAdminGatewayContext();
  await Payment.updateOne({ _id: ctx.paymentId }, { $set: { status: PaymentStatus.PENDING } });
  const original = phonePeProvider.getOrderStatus.bind(phonePeProvider);
  phonePeProvider.getOrderStatus = async () => {
    throw new Error("timeout while calling mock");
  };
  try {
    const res = await poll(ctx.token, ctx.paymentId, "poll-timeout");
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, "PROVIDER_TIMEOUT");
    assert.equal(String(res.body.error.message).includes("mock"), false);
  } finally {
    phonePeProvider.getOrderStatus = original;
  }
});

test("repeated polling on terminal payment does not duplicate rows", async () => {
  const ctx = await seedAdminGatewayContext();
  await Payment.updateOne({ _id: ctx.paymentId }, { $set: { status: PaymentStatus.SUCCESS } });
  const beforeLedger = await LedgerEntry.countDocuments({ paymentId: ctx.paymentId });
  const beforeOutbox = await OutboxEvent.countDocuments({});
  const beforeAlerts = await Alert.countDocuments({});
  await poll(ctx.token, ctx.paymentId, "poll-repeat-1");
  await poll(ctx.token, ctx.paymentId, "poll-repeat-2");
  assert.equal(await LedgerEntry.countDocuments({ paymentId: ctx.paymentId }), beforeLedger);
  assert.equal(await OutboxEvent.countDocuments({}), beforeOutbox);
  assert.equal(await Alert.countDocuments({}), beforeAlerts);
});

test("unknown payment returns 404", async () => {
  const ctx = await seedAdminGatewayContext();
  const res = await poll(ctx.token, createId("payment"), "poll-unknown");
  assert.equal(res.status, 404);
});

test("non-gateway payment rejected", async () => {
  const ctx = await seedAdminGatewayContext();
  await Payment.updateOne({ _id: ctx.paymentId }, { $set: { mode: PaymentMode.CASH } });
  const res = await poll(ctx.token, ctx.paymentId, "poll-non-gw");
  assert.equal(res.status, 422);
});
