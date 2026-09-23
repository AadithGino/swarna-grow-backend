import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { GatewayRefundStatus, TenantRole } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { phonePeProvider } from "../src/integrations/phonepe.provider.js";
import { Payment, PaymentRefund, Tenant } from "../src/models/index.js";
import { processPhonePeRefundWebhook } from "../src/services/phonepe-refund.service.js";
import {
  configureTenantPhonePe,
  refundHeaders,
  seedAdminGatewayContext,
  seedBranchManagerContext,
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

test("ambiguous provider timeout retains reservation and marks PENDING_RECONCILIATION", async () => {
  const ctx = await seedAdminGatewayContext();
  const original = phonePeProvider.initiateRefund.bind(phonePeProvider);
  phonePeProvider.initiateRefund = async () => {
    const err = new Error("provider socket timeout ETIMEDOUT");
    err.code = "ETIMEDOUT";
    throw err;
  };
  try {
    const res = await postRefund(ctx.token, ctx.paymentId, { amountPaise: 11_000, reason: "Timeout case" }, "idem-timeout");
    assert.equal(res.status, 503);
    const payment = await Payment.findById(ctx.paymentId).lean();
    assert.equal(payment.gatewayRefundReservedPaise, 11_000);
    const refund = await PaymentRefund.findOne({ paymentId: ctx.paymentId }).lean();
    assert.equal(refund.status, GatewayRefundStatus.PENDING_RECONCILIATION);
    assert.equal(refund.requiresReview, true);
  } finally {
    phonePeProvider.initiateRefund = original;
  }
});

test("definitive provider rejection releases reservation", async () => {
  const ctx = await seedAdminGatewayContext();
  const original = phonePeProvider.initiateRefund.bind(phonePeProvider);
  phonePeProvider.initiateRefund = async () => {
    const { AppError } = await import("../src/lib/app-error.js");
    throw new AppError("PHONEPE_REFUND_REJECTED", "Rejected", 422);
  };
  try {
    const res = await postRefund(ctx.token, ctx.paymentId, { amountPaise: 9000, reason: "Reject case" }, "idem-reject");
    assert.equal(res.status, 422);
    const payment = await Payment.findById(ctx.paymentId).lean();
    assert.equal(payment.gatewayRefundReservedPaise, 0);
    const refund = await PaymentRefund.findOne({ paymentId: ctx.paymentId }).lean();
    assert.equal(refund.status, GatewayRefundStatus.FAILED);
  } finally {
    phonePeProvider.initiateRefund = original;
  }
});

test("missing credentials after reservation releases reservation on retry", async () => {
  const ctx = await seedAdminGatewayContext();
  const original = phonePeProvider.initiateRefund.bind(phonePeProvider);
  phonePeProvider.initiateRefund = async () => {
    const err = new Error("timeout ETIMEDOUT");
    err.code = "ETIMEDOUT";
    throw err;
  };
  try {
    assert.equal((await postRefund(ctx.token, ctx.paymentId, { amountPaise: 7000, reason: "Cred drop" }, "idem-cred")).status, 503);
    await Tenant.updateOne({ _id: ctx.tenant._id }, { $unset: { integrationSecrets: "" } });
    const retry = await postRefund(ctx.token, ctx.paymentId, { amountPaise: 7000, reason: "Cred drop" }, "idem-cred");
    assert.equal(retry.status, 422);
    const payment = await Payment.findById(ctx.paymentId).lean();
    assert.equal(payment.gatewayRefundReservedPaise, 0);
  } finally {
    phonePeProvider.initiateRefund = original;
  }
});

test("retry after timeout reuses same refund and succeeds", async () => {
  const ctx = await seedAdminGatewayContext();
  let calls = 0;
  const original = phonePeProvider.initiateRefund.bind(phonePeProvider);
  phonePeProvider.initiateRefund = async (args) => {
    calls += 1;
    if (calls === 1) {
      const err = new Error("timeout ETIMEDOUT");
      err.code = "ETIMEDOUT";
      throw err;
    }
    return original(args);
  };
  try {
    assert.equal((await postRefund(ctx.token, ctx.paymentId, { amountPaise: 6000, reason: "Retry same" }, "idem-retry")).status, 503);
    const retry = await postRefund(ctx.token, ctx.paymentId, { amountPaise: 6000, reason: "Retry same" }, "idem-retry");
    assert.equal(retry.status, 202);
    assert.equal(await PaymentRefund.countDocuments({ paymentId: ctx.paymentId }), 1);
    const refund = await PaymentRefund.findOne({ paymentId: ctx.paymentId }).lean();
    assert.equal(refund.status, GatewayRefundStatus.PENDING);
    assert.equal(refund.providerInitiationError ?? null, null);
    assert.equal(calls, 2);
  } finally {
    phonePeProvider.initiateRefund = original;
  }
});

test("manual release with provider confirmation clears reservation", async () => {
  const ctx = await seedAdminGatewayContext({ role: TenantRole.TENANT_OWNER });
  await Payment.updateOne({ _id: ctx.paymentId }, { $inc: { gatewayRefundReservedPaise: 14_000 } });
  const refundId = createId("pref");
  const refund = await PaymentRefund.create({
    _id: refundId,
    tenantId: ctx.tenant._id,
    paymentId: ctx.paymentId,
    providerRefundId: refundId,
    amountPaise: 14_000,
    status: GatewayRefundStatus.PENDING_RECONCILIATION,
    requiresReview: true,
    reason: "Stuck reservation",
  });
  const res = await request(app)
    .post(`/api/v1/admin/payments/${ctx.paymentId}/refunds/${refund._id}/release`)
    .set("authorization", `Bearer ${ctx.token}`)
    .set(refundHeaders("idem-release-manual"))
    .send({
      reason: "Ops verified provider never accepted refund",
      providerConfirmedNotAccepted: true,
      evidence: "PhonePe dashboard screenshot ref 123",
    });
  assert.equal(res.status, 200);
  const payment = await Payment.findById(ctx.paymentId).lean();
  assert.equal(payment.gatewayRefundReservedPaise, 0);
});

test("provider reconcile FAILED releases reservation once", async () => {
  const ctx = await seedAdminGatewayContext();
  await configureTenantPhonePe(ctx.tenant._id);
  await postRefund(ctx.token, ctx.paymentId, { amountPaise: 10_000, reason: "Reconcile fail" }, "idem-recon-fail");
  const refund = await PaymentRefund.findOne({ paymentId: ctx.paymentId }).lean();
  const originalStatus = phonePeProvider.getRefundStatus.bind(phonePeProvider);
  phonePeProvider.getRefundStatus = async () => ({ state: "FAILED", amount: 0 });
  const recon = await request(app)
    .post(`/api/v1/admin/payments/${ctx.paymentId}/refunds/${refund._id}/reconcile`)
    .set("authorization", `Bearer ${ctx.token}`)
    .set(refundHeaders("idem-recon-call"))
    .send({});
  assert.equal(recon.status, 200);
  const payment = await Payment.findById(ctx.paymentId).lean();
  assert.equal(payment.gatewayRefundReservedPaise, 0);
  await processPhonePeRefundWebhook({
    tenantId: ctx.tenant._id,
    type: "PG_REFUND_FAILED",
    payload: { originalMerchantOrderId: ctx.intentId, refundId: refund.providerRefundId },
    providerEventId: "dup_fail_after_recon",
  });
  assert.equal((await Payment.findById(ctx.paymentId).lean()).gatewayRefundReservedPaise, 0);
  phonePeProvider.getRefundStatus = originalStatus;
});

test("branch manager list/reconcile/release own branch; off-branch returns 404", async () => {
  const { ownerCtx, otherPayment, manager } = await seedBranchManagerContext();
  await configureTenantPhonePe(ownerCtx.tenant._id);
  await postRefund(
    ownerCtx.token,
    ownerCtx.paymentId,
    { amountPaise: 5000, reason: "Scope list" },
    "idem-scope-list",
  );
  const refund = await PaymentRefund.findOne({ paymentId: ownerCtx.paymentId }).lean();
  const listOk = await request(app)
    .get(`/api/v1/admin/payments/${ownerCtx.paymentId}/refunds`)
    .set("authorization", `Bearer ${manager.token}`);
  assert.equal(listOk.status, 200);
  const listDenied = await request(app)
    .get(`/api/v1/admin/payments/${otherPayment.paymentId}/refunds`)
    .set("authorization", `Bearer ${manager.token}`);
  assert.equal(listDenied.status, 404);
  const reconDenied = await request(app)
    .post(`/api/v1/admin/payments/${otherPayment.paymentId}/refunds/${refund._id}/reconcile`)
    .set("authorization", `Bearer ${manager.token}`)
    .set(refundHeaders("idem-scope-recon-deny"))
    .send({});
  assert.equal(reconDenied.status, 404);
  const releaseDenied = await request(app)
    .post(`/api/v1/admin/payments/${otherPayment.paymentId}/refunds/${refund._id}/release`)
    .set("authorization", `Bearer ${manager.token}`)
    .set(refundHeaders("idem-scope-release-deny"))
    .send({
      reason: "Should not apply",
      providerConfirmedNotAccepted: true,
      evidence: "Off-branch attempt documented",
    });
  assert.equal(releaseDenied.status, 404);
});

test("manual release without evidence when providerConfirmedNotAccepted returns 400", async () => {
  const ctx = await seedAdminGatewayContext();
  const refundId = createId("pref");
  await PaymentRefund.create({
    _id: refundId,
    tenantId: ctx.tenant._id,
    paymentId: ctx.paymentId,
    providerRefundId: refundId,
    amountPaise: 5000,
    status: GatewayRefundStatus.PENDING_RECONCILIATION,
    reason: "Stuck",
  });
  const res = await request(app)
    .post(`/api/v1/admin/payments/${ctx.paymentId}/refunds/${refundId}/release`)
    .set("authorization", `Bearer ${ctx.token}`)
    .set(refundHeaders("idem-release-no-evidence"))
    .send({
      reason: "Ops confirmed not accepted",
      providerConfirmedNotAccepted: true,
    });
  assert.equal(res.status, 400);
});

test("insufficient reserved balance blocks manual release without audit", async () => {
  const ctx = await seedAdminGatewayContext();
  const refundId = createId("pref");
  await Payment.updateOne({ _id: ctx.paymentId }, { $set: { gatewayRefundReservedPaise: 0 } });
  await PaymentRefund.create({
    _id: refundId,
    tenantId: ctx.tenant._id,
    paymentId: ctx.paymentId,
    providerRefundId: refundId,
    amountPaise: 9000,
    status: GatewayRefundStatus.PENDING_RECONCILIATION,
    reason: "Mismatch reservation",
  });
  const beforeAudits = await import("../src/models/index.js").then((m) => m.AuditEvent.countDocuments({
    action: "GATEWAY_REFUND_RESERVATION_RELEASED",
    entityId: ctx.paymentId,
  }));
  const res = await request(app)
    .post(`/api/v1/admin/payments/${ctx.paymentId}/refunds/${refundId}/release`)
    .set("authorization", `Bearer ${ctx.token}`)
    .set(refundHeaders("idem-release-insufficient"))
    .send({
      reason: "Ops verified provider never accepted refund",
      providerConfirmedNotAccepted: true,
      evidence: "PhonePe support ticket #9988776655 confirms rejection",
    });
  assert.equal(res.status, 422);
  assert.equal(res.body?.error?.code, "GATEWAY_REFUND_RESERVATION_INCONSISTENT");
  const refund = await PaymentRefund.findById(refundId).lean();
  assert.equal(refund.status, GatewayRefundStatus.PENDING_RECONCILIATION);
  const afterAudits = await import("../src/models/index.js").then((m) => m.AuditEvent.countDocuments({
    action: "GATEWAY_REFUND_RESERVATION_RELEASED",
    entityId: ctx.paymentId,
  }));
  assert.equal(afterAudits, beforeAudits);
});
