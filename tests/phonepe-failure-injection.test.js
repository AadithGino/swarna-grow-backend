import test from "node:test";
import assert from "node:assert/strict";
import { CallbackType } from "@phonepe-pg/pg-sdk-node";
import {
  GatewayRefundStatus,
  PaymentIntentStatus,
  PaymentMode,
  PaymentStatus,
} from "../src/constants/enums.js";
import { clearGatewayTxFaults, setGatewayTxFaultAfter } from "../src/lib/gateway-tx-faults.js";
import {
  Alert,
  AuditEvent,
  Customer,
  LedgerEntry,
  Payment,
  PaymentIntent,
  PaymentRefund,
  Scheme,
  WebhookEvent,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { applyTerminalGatewayFailure } from "../src/services/gateway-terminal-failure.service.js";
import {
  finalizeGatewaySuccess,
  GatewayFinalizeOutcome,
} from "../src/services/finalize-gateway-success.service.js";
import { reconcileGatewayPayment } from "../src/services/phonepe-reconcile.service.js";
import { processPhonePeRefundWebhook } from "../src/services/phonepe-refund.service.js";
import { processWebhook } from "../src/workers/processors.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  clearGatewayTxFaults();
});

async function seedPending({ mockSuffix = "" } = {}) {
  const { tenant, branch, user } = await seedTenantUser();
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "Test",
    mobile: `+9188${String(Date.now()).slice(-8)}`,
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      paymentRules: { partialPaymentAllowed: true, advancePaymentAllowed: false, maxAdvanceInstallments: 0, minPaymentPaise: 1000 },
    },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installmentAmountPaise: 50_000,
    installments: [{ number: 1, dueDate: "2026-01-05", amountPaise: 50_000, paidPaise: 0, status: "DUE", graceEndsAt: "2026-01-10" }],
    positionVersion: 1,
    version: 1,
    createdBy: user._id,
  });
  const intentId = `${createId("paymentIntent")}${mockSuffix}`;
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    receiptNumber: `PENDING-${intentId}`,
    amountPaise: 50_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(Date.now() - 3600_000),
  });
  await PaymentIntent.create({
    _id: intentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    amountPaise: 50_000,
    positionVersion: 1,
    status: PaymentIntentStatus.PENDING,
    paymentId,
    version: 1,
  });
  return { tenant, paymentId, intentId };
}

test("amount mismatch rolls back on each atomic boundary", async () => {
  for (const checkpoint of [
    "mismatch:payment-updated",
    "mismatch:intent-updated",
    "mismatch:link-updated",
    "mismatch:scheme-updated",
    "mismatch:alert-upserted",
    "mismatch:audit-written",
  ]) {
    await resetTestDb();
    clearGatewayTxFaults();
    const { tenant, paymentId, intentId } = await seedPending();
    const intent = await PaymentIntent.findById(intentId).lean();
    setGatewayTxFaultAfter(checkpoint);
    await assert.rejects(() => finalizeGatewaySuccess({
      tenantId: tenant._id,
      reference: intentId,
      transactionId: `mis_${checkpoint}`,
      amountPaise: 49_000,
      providerPayload: {},
      webhookEventId: "wh_mis",
      intent,
    }));
    assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.PENDING);
  }
});

test("terminal failure rolls back on each write boundary", async () => {
  for (const checkpoint of [
    "terminalFailure:payment-updated",
    "terminalFailure:intent-updated",
    "terminalFailure:link-updated",
    "terminalFailure:scheme-updated",
    "terminalFailure:outbox-created",
    "terminalFailure:audit-written",
  ]) {
    await resetTestDb();
    clearGatewayTxFaults();
    const { tenant, paymentId, intentId } = await seedPending();
    setGatewayTxFaultAfter(checkpoint);
    await assert.rejects(() => applyTerminalGatewayFailure({
      tenantId: tenant._id,
      paymentId,
      reference: intentId,
      providerPayload: {},
    }));
    assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.PENDING);
  }
});

test("reconcile reports AMOUNT_MISMATCH not COMPLETED when provider amount differs", async () => {
  const { paymentId } = await seedPending({ mockSuffix: "__mock_completed_49000__" });
  const payment = await Payment.findById(paymentId).lean();
  const result = await reconcileGatewayPayment(payment);
  assert.equal(result.outcome, "AMOUNT_MISMATCH");
  assert.notEqual((await Payment.findById(paymentId).lean()).status, PaymentStatus.SUCCESS);
});

test("reconcile treats missing transaction id as progress not COMPLETED", async () => {
  const { paymentId } = await seedPending({ mockSuffix: "__mock_completed_no_txn__" });
  const payment = await Payment.findById(paymentId).lean();
  const result = await reconcileGatewayPayment(payment);
  assert.equal(result.outcome, "MISSING_TRANSACTION_ID");
  assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.PENDING);
});

test("webhook completion racing reconciliation converges idempotently", async () => {
  const { tenant, paymentId, intentId } = await seedPending({ mockSuffix: "__mock_completed__" });
  const payment = await Payment.findById(paymentId).lean();
  const eventId = createId("webhook");
  await WebhookEvent.create({
    _id: eventId,
    tenantId: tenant._id,
    provider: "PHONEPE",
    providerEventId: `race-${intentId}`,
    status: "QUEUED",
    payload: {
      type: CallbackType.CHECKOUT_ORDER_COMPLETED,
      payload: {
        originalMerchantOrderId: intentId,
        amount: 50_000,
        paymentDetails: [{ state: "COMPLETED", transactionId: `race_txn_${intentId}`, amount: 50_000 }],
      },
    },
  });
  await Promise.allSettled([
    processWebhook({ data: { webhookEventId: eventId }, id: "job-a", attemptsMade: 0 }),
    reconcileGatewayPayment({ ...payment }),
  ]);
  assert.equal(await LedgerEntry.countDocuments({ tenantId: tenant._id, paymentId }), 1);
  assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.SUCCESS);
});

test("success after terminal failure is ignored; terminal after success is ignored", async () => {
  const { tenant, paymentId, intentId } = await seedPending({ mockSuffix: "__mock_completed__" });
  const intent = await PaymentIntent.findById(intentId).lean();
  const fin = await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intentId,
    transactionId: `race_ok_${intentId}`,
    amountPaise: 50_000,
    providerPayload: {},
    webhookEventId: "wh_ok",
    intent,
  });
  assert.equal(fin.outcome, GatewayFinalizeOutcome.SUCCESS);
  const blocked = await applyTerminalGatewayFailure({
    tenantId: tenant._id,
    paymentId,
    reference: intentId,
    providerPayload: {},
  });
  assert.equal(blocked.skipped, true);
  assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.SUCCESS);
});

async function seedPaidForPartialRefund() {
  const { tenant, paymentId, intentId } = await seedPending({ mockSuffix: "__mock_completed__" });
  const intent = await PaymentIntent.findById(intentId).lean();
  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intentId,
    transactionId: `partial_base_${intentId}`,
    amountPaise: 50_000,
    providerPayload: {},
    webhookEventId: "wh_partial_base",
    intent,
  });
  return { tenant, paymentId, intentId };
}

function snapshotPartialRefundState({ tenantId, paymentId }) {
  return Promise.all([
    Payment.findById(paymentId).lean(),
    PaymentRefund.find({ tenantId, paymentId }).lean(),
    Alert.find({ tenantId, entityId: paymentId }).lean(),
    AuditEvent.find({ tenantId, entityId: paymentId }).lean(),
    Scheme.findOne({ tenantId }).lean(),
  ]);
}

test("partial refund review rolls back on each atomic boundary", async () => {
  for (const checkpoint of [
    "partialRefund:payment-updated",
    "partialRefund:refund-updated",
    "partialRefund:alert-upserted",
    "partialRefund:audit-written",
  ]) {
    await resetTestDb();
    clearGatewayTxFaults();
    const { tenant, paymentId, intentId } = await seedPaidForPartialRefund();
    const before = await snapshotPartialRefundState({ tenantId: tenant._id, paymentId });
    setGatewayTxFaultAfter(checkpoint);
    await assert.rejects(() => processPhonePeRefundWebhook({
      tenantId: tenant._id,
      type: "PG_REFUND_COMPLETED",
      payload: {
        originalMerchantOrderId: intentId,
        refundId: `partial_${checkpoint}`,
        amount: 25_000,
        currency: "INR",
      },
      providerEventId: `pe-${checkpoint}`,
    }));
    const after = await snapshotPartialRefundState({ tenantId: tenant._id, paymentId });
    assert.deepEqual(after[0], before[0]);
    assert.deepEqual(after[2], before[2]);
    assert.deepEqual(after[3], before[3]);
    assert.deepEqual(after[4], before[4]);
    for (const refund of after[1]) {
      assert.equal(refund.status, GatewayRefundStatus.PENDING);
      assert.notEqual(refund.requiresReview, true);
    }
  }
});

test("partial refund retry converges to one alert and review state", async () => {
  const { tenant, paymentId, intentId } = await seedPaidForPartialRefund();
  const payload = {
    originalMerchantOrderId: intentId,
    refundId: "partial_retry_1",
    amount: 25_000,
    currency: "INR",
  };
  const args = {
    tenantId: tenant._id,
    type: "PG_REFUND_COMPLETED",
    payload,
    providerEventId: "pe-partial-retry",
  };
  setGatewayTxFaultAfter("partialRefund:alert-upserted");
  await assert.rejects(() => processPhonePeRefundWebhook(args));
  clearGatewayTxFaults();
  const repaired = await processPhonePeRefundWebhook(args);
  assert.equal(repaired.outcome, "PARTIAL_REVIEW");
  const alerts = await Alert.find({
    tenantId: tenant._id,
    type: "GATEWAY_REFUND_PARTIAL",
    entityId: paymentId,
  }).lean();
  assert.equal(alerts.length, 1);
  const payment = await Payment.findById(paymentId).lean();
  assert.equal(payment.requiresReview, true);
  assert.equal(payment.reviewReason, "PARTIAL_REFUND_REQUIRES_REVIEW");
});

test("two concurrent full-refund callbacks converge to one reversal", async () => {
  const { tenant, paymentId, intentId } = await seedPending({ mockSuffix: "__mock_completed__" });
  const intent = await PaymentIntent.findById(intentId).lean();
  const fin = await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intentId,
    transactionId: `ref_race_${intentId}`,
    amountPaise: 50_000,
    providerPayload: {},
    webhookEventId: "wh_fin",
    intent,
  });
  assert.equal(fin.outcome, GatewayFinalizeOutcome.SUCCESS);
  const payload = {
    originalMerchantOrderId: intentId,
    refundId: "ref_concurrent_1",
    amount: 50_000,
    currency: "INR",
  };
  const args = {
    tenantId: tenant._id,
    type: "PG_REFUND_COMPLETED",
    payload,
    providerEventId: "pe-ref-concurrent",
  };
  const settled = await Promise.allSettled([
    processPhonePeRefundWebhook(args),
    processPhonePeRefundWebhook(args),
  ]);
  assert.equal(await LedgerEntry.countDocuments({ tenantId: tenant._id, paymentId, type: "REVERSAL" }), 1);
  assert.equal(
    settled.filter((row) => row.status === "fulfilled" && row.value?.outcome === "COMPLETED").length,
    1,
  );
});
