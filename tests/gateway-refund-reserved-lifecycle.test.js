import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { GatewayRefundStatus, PaymentStatus, TenantRole } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { gatewayRefundableBalancePaise, assertNonNegativeGatewayRefundReserved } from "../src/lib/gateway-refundable-balance.js";
import { phonePeProvider } from "../src/integrations/phonepe.provider.js";
import { processPhonePeRefundWebhook } from "../src/services/phonepe-refund.service.js";
import { AuditEvent, LedgerEntry, Payment, PaymentRefund } from "../src/models/index.js";
import {
  configureTenantPhonePe,
  refundHeaders,
  seedAdminGatewayContext,
} from "./helpers/gateway-http-fixture.js";
import { resetTestDb, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function postRefund(token, paymentId, body, idempotencyKey) {
  return request(app)
    .post(`/api/v1/admin/payments/${paymentId}/refunds`)
    .set("authorization", `Bearer ${token}`)
    .set(refundHeaders(idempotencyKey))
    .send(body);
}

test("initiation increments gatewayRefundReservedPaise exactly once", async () => {
  const ctx = await seedAdminGatewayContext({ role: TenantRole.TENANT_OWNER });
  const before = await Payment.findById(ctx.paymentId).lean();
  assert.equal(before.gatewayRefundReservedPaise ?? 0, 0);
  const res = await postRefund(ctx.token, ctx.paymentId, { amountPaise: 20_000, reason: "Reserve test" }, "idem-reserve-1");
  assert.equal(res.status, 202);
  const after = await Payment.findById(ctx.paymentId).lean();
  assert.equal(after.gatewayRefundReservedPaise, 20_000);
  assertNonNegativeGatewayRefundReserved(after);
  assert.equal(gatewayRefundableBalancePaise(after), after.amountPaise - 20_000);
});

test("idempotent replay and conflicting body do not change reservation", async () => {
  const ctx = await seedAdminGatewayContext();
  await postRefund(ctx.token, ctx.paymentId, { amountPaise: 15_000, reason: "Same body" }, "idem-same-res");
  await postRefund(ctx.token, ctx.paymentId, { amountPaise: 15_000, reason: "Same body" }, "idem-same-res");
  const conflict = await postRefund(ctx.token, ctx.paymentId, { amountPaise: 16_000, reason: "Same body" }, "idem-same-res");
  assert.equal(conflict.status, 409);
  const payment = await Payment.findById(ctx.paymentId).lean();
  assert.equal(payment.gatewayRefundReservedPaise, 15_000);
});

test("provider transient failure keeps retryable reservation", async () => {
  const ctx = await seedAdminGatewayContext();
  const original = phonePeProvider.initiateRefund.bind(phonePeProvider);
  phonePeProvider.initiateRefund = async () => { throw new Error("transient"); };
  try {
    assert.equal((await postRefund(ctx.token, ctx.paymentId, { amountPaise: 8000, reason: "Retry keep" }, "idem-transient")).status, 503);
    assert.equal((await Payment.findById(ctx.paymentId).lean()).gatewayRefundReservedPaise, 8000);
    phonePeProvider.initiateRefund = original;
    assert.equal((await postRefund(ctx.token, ctx.paymentId, { amountPaise: 8000, reason: "Retry keep" }, "idem-transient")).status, 202);
    assert.equal((await Payment.findById(ctx.paymentId).lean()).gatewayRefundReservedPaise, 8000);
  } finally {
    phonePeProvider.initiateRefund = original;
  }
});

test("FAILED callback releases reservation once; duplicate FAILED does not go negative", async () => {
  const ctx = await seedAdminGatewayContext();
  await configureTenantPhonePe(ctx.tenant._id);
  await postRefund(ctx.token, ctx.paymentId, { amountPaise: 12_000, reason: "Fail release" }, "idem-fail-release");
  const refund = await PaymentRefund.findOne({ paymentId: ctx.paymentId }).lean();
  const intentId = ctx.intentId;
  const failArgs = {
    tenantId: ctx.tenant._id,
    type: "PG_REFUND_FAILED",
    payload: { originalMerchantOrderId: intentId, refundId: refund.providerRefundId },
    providerEventId: "pe_fail_once",
  };
  await processPhonePeRefundWebhook(failArgs);
  let payment = await Payment.findById(ctx.paymentId).lean();
  assert.equal(payment.gatewayRefundReservedPaise, 0);
  await processPhonePeRefundWebhook({ ...failArgs, providerEventId: "pe_fail_dup" });
  payment = await Payment.findById(ctx.paymentId).lean();
  assert.equal(payment.gatewayRefundReservedPaise, 0);
  assertNonNegativeGatewayRefundReserved(payment);
});

test("partial completion releases only completed refund amount", async () => {
  const ctx = await seedAdminGatewayContext({ role: TenantRole.TENANT_OWNER });
  await Payment.updateOne({ _id: ctx.paymentId }, { $set: { amountPaise: 100_000, gatewayRefundReservedPaise: 25_000 } });
  await PaymentRefund.create({
    _id: createId("pref"),
    tenantId: ctx.tenant._id,
    paymentId: ctx.paymentId,
    providerRefundId: "ref_partial_webhook",
    amountPaise: 25_000,
    status: GatewayRefundStatus.PENDING,
  });
  await processPhonePeRefundWebhook({
    tenantId: ctx.tenant._id,
    type: "PG_REFUND_COMPLETED",
    payload: {
      originalMerchantOrderId: ctx.intentId,
      refundId: "ref_partial_webhook",
      amount: 25_000,
      currency: "INR",
    },
    providerEventId: "pe_partial_complete",
  });
  const payment = await Payment.findById(ctx.paymentId).lean();
  assert.equal(payment.refundedAmountPaise, 25_000);
  assert.equal(payment.gatewayRefundReservedPaise, 0);
  assert.equal(payment.status, PaymentStatus.PARTIALLY_REFUNDED);
  assert.equal(await LedgerEntry.countDocuments({ paymentId: ctx.paymentId, type: "REVERSAL" }), 1);
});

test("multiple pending refunds sum within refundable balance", async () => {
  const ctx = await seedAdminGatewayContext({ role: TenantRole.TENANT_OWNER });
  await Payment.updateOne({ _id: ctx.paymentId }, { $set: { amountPaise: 100_000 } });
  await postRefund(ctx.token, ctx.paymentId, { amountPaise: 30_000, reason: "Multi A" }, "idem-multi-a");
  await postRefund(ctx.token, ctx.paymentId, { amountPaise: 20_000, reason: "Multi B" }, "idem-multi-b");
  const payment = await Payment.findById(ctx.paymentId).lean();
  assert.equal(payment.gatewayRefundReservedPaise, 50_000);
  assert.ok(gatewayRefundableBalancePaise(payment) >= 0);
  assert.equal(await AuditEvent.countDocuments({ action: "GATEWAY_REFUND_INITIATED", entityId: ctx.paymentId }), 2);
});
