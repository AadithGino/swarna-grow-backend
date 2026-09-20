import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../src/config/env.js";
import {
  GatewayRefundStatus,
  PaymentIntentStatus,
  PaymentMode,
  PaymentStatus,
  TenantStatus,
} from "../src/constants/enums.js";
import { clearGatewayTxFaults, setGatewayTxFaultAfter } from "../src/lib/gateway-tx-faults.js";
import {
  getTransactionSessionStartsForTests,
  resetTransactionTestMetrics,
} from "../src/lib/transaction.js";
import { assertWebhookTenantReceivable } from "../src/lib/webhook-tenant-guard.js";
import {
  Alert,
  Customer,
  LedgerEntry,
  OutboxEvent,
  Payment,
  PaymentIntent,
  PaymentRefund,
  Scheme,
  Tenant,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { applyTerminalGatewayFailure } from "../src/services/gateway-terminal-failure.service.js";
import {
  finalizeGatewaySuccess,
  GatewayFinalizeOutcome,
} from "../src/services/finalize-gateway-success.service.js";
import {
  reconcileGatewayPayment,
  reconcilePaymentById,
} from "../src/services/phonepe-reconcile.service.js";
import { processPhonePeRefundWebhook } from "../src/services/phonepe-refund.service.js";
import { runPaymentExpiry } from "../src/services/payment-expiry.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  clearGatewayTxFaults();
  resetTransactionTestMetrics();
});

async function seedGatewayFixture() {
  const { tenant, branch, user } = await seedTenantUser();
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "Gateway Customer",
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
      paymentRules: {
        partialPaymentAllowed: true,
        advancePaymentAllowed: false,
        maxAdvanceInstallments: 0,
        minPaymentPaise: 1000,
      },
    },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installmentAmountPaise: 50_000,
    installments: [{
      number: 1,
      dueDate: "2026-01-05",
      amountPaise: 50_000,
      paidPaise: 0,
      status: "DUE",
      graceEndsAt: "2026-01-10",
    }],
    positionVersion: 1,
    version: 1,
    createdBy: user._id,
  });
  return { tenant, branch, customer, scheme, user };
}

async function seedPendingGatewayPayment({ mockSuffix }) {
  const { tenant, branch, customer, scheme } = await seedGatewayFixture();
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
  return { tenant, paymentId, intentId, scheme };
}

test("finalizeGatewaySuccess uses one Mongo session (no nested withTransaction)", async () => {
  assert.equal(env.PROVIDER_MODE, "mock");
  const { tenant, paymentId, intentId } = await seedPendingGatewayPayment({
    mockSuffix: "__mock_completed__",
  });
  const intent = await PaymentIntent.findById(intentId).lean();
  resetTransactionTestMetrics();
  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intentId,
    transactionId: `txn_${intentId}`,
    amountPaise: 50_000,
    providerPayload: { test: true },
    webhookEventId: "wh_1",
    intent,
  });
  assert.equal(getTransactionSessionStartsForTests(), 1);
  const payment = await Payment.findById(paymentId).lean();
  assert.equal(payment.status, PaymentStatus.SUCCESS);
  assert.equal(await LedgerEntry.countDocuments({ tenantId: tenant._id, paymentId }), 1);
});

test("recordPayment gateway success rolls back on each write-boundary fault", async () => {
  const checkpoints = [
    "recordPayment:payment-saved",
    "recordPayment:ledger-created",
    "recordPayment:scheme-saved",
    "recordPayment:outbox-created",
    "recordPayment:audit-written",
  ];
  for (const checkpoint of checkpoints) {
    await resetTestDb();
    clearGatewayTxFaults();
    const { tenant, paymentId, intentId } = await seedPendingGatewayPayment({
      mockSuffix: "__mock_completed__",
    });
    const intent = await PaymentIntent.findById(intentId).lean();
    setGatewayTxFaultAfter(checkpoint);
    await assert.rejects(() => finalizeGatewaySuccess({
      tenantId: tenant._id,
      reference: intentId,
      transactionId: `fault_${checkpoint}_${intentId}`,
      amountPaise: 50_000,
      providerPayload: {},
      webhookEventId: `wh_${checkpoint}`,
      intent,
    }));
    assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.PENDING);
    assert.equal(await LedgerEntry.countDocuments({ tenantId: tenant._id, paymentId }), 0);
  }
});

test("terminal gateway failure rolls back on injected fault", async () => {
  const { tenant, paymentId, intentId } = await seedPendingGatewayPayment({ mockSuffix: "" });
  setGatewayTxFaultAfter("terminalFailure:audit-written");
  await assert.rejects(() => applyTerminalGatewayFailure({
    tenantId: tenant._id,
    paymentId,
    reference: intentId,
    providerPayload: { test: true },
  }));
  const payment = await Payment.findById(paymentId).lean();
  assert.equal(payment.status, PaymentStatus.PENDING);
  assert.equal(await OutboxEvent.countDocuments({ tenantId: tenant._id, key: paymentId }), 0);
});

test("duplicate success callback is idempotent", async () => {
  const { tenant, paymentId, intentId } = await seedPendingGatewayPayment({
    mockSuffix: "__mock_completed__",
  });
  const intent = await PaymentIntent.findById(intentId).lean();
  const args = {
    tenantId: tenant._id,
    reference: intentId,
    transactionId: `dup_txn_${intentId}`,
    amountPaise: 50_000,
    providerPayload: {},
    webhookEventId: "wh_dup",
    intent,
  };
  await finalizeGatewaySuccess(args);
  await finalizeGatewaySuccess(args);
  assert.equal(await LedgerEntry.countDocuments({ tenantId: tenant._id, paymentId }), 1);
  assert.equal(await Payment.countDocuments({ tenantId: tenant._id, status: PaymentStatus.SUCCESS }), 1);
});

test("terminal failure skipped when payment already succeeded", async () => {
  const { tenant, paymentId, intentId } = await seedPendingGatewayPayment({
    mockSuffix: "__mock_completed__",
  });
  const intent = await PaymentIntent.findById(intentId).lean();
  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intentId,
    transactionId: `race_txn_${intentId}`,
    amountPaise: 50_000,
    providerPayload: {},
    webhookEventId: "wh_race",
    intent,
  });
  const result = await applyTerminalGatewayFailure({
    tenantId: tenant._id,
    paymentId,
    reference: intentId,
    providerPayload: { lateFailure: true },
  });
  assert.equal(result.skipped, true);
  assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.SUCCESS);
});

test("reconcile rejects COMPLETED without provider amount", async () => {
  const { paymentId } = await seedPendingGatewayPayment({ mockSuffix: "__mock_completed_zero__" });
  const payment = await Payment.findById(paymentId).lean();
  const result = await reconcileGatewayPayment(payment);
  assert.equal(result.outcome, "MISSING_OR_INVALID_AMOUNT");
  assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.PENDING);
});

test("amount mismatch does not record success payment", async () => {
  const { tenant, paymentId, intentId } = await seedPendingGatewayPayment({ mockSuffix: "" });
  const intent = await PaymentIntent.findById(intentId).lean();
  const result = await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intentId,
    transactionId: `mis_${intentId}`,
    amountPaise: 49_000,
    providerPayload: {},
    webhookEventId: "wh_mis",
    intent,
  });
  assert.equal(result.outcome, GatewayFinalizeOutcome.AMOUNT_MISMATCH);
  assert.equal(
    (await Payment.findById(paymentId).lean()).status,
    PaymentStatus.AMOUNT_MISMATCH_PENDING_REVIEW,
  );
  const alert = await Alert.findOne({ tenantId: tenant._id, type: "GATEWAY_AMOUNT_MISMATCH" }).lean();
  assert.ok(alert);
});

test("reconcile exhaustion stops scheduler polling until manual force replay", async () => {
  const maxAttempts = env.PHONEPE_RECONCILE_MAX_ATTEMPTS ?? 5;
  const { tenant, paymentId } = await seedPendingGatewayPayment({ mockSuffix: "__mock_transient__" });
  await Payment.updateOne(
    { _id: paymentId, tenantId: tenant._id },
    { $set: { gatewayReconcileAttempts: maxAttempts - 1 } },
  );
  let payment = await Payment.findById(paymentId).lean();
  await reconcileGatewayPayment(payment);
  payment = await Payment.findById(paymentId).lean();
  assert.equal(payment.reviewReason, "GATEWAY_RECONCILE_EXHAUSTED");
  const blocked = await reconcilePaymentById({ tenantId: tenant._id, paymentId });
  assert.equal(blocked.outcome, "EXHAUSTED_REQUIRES_FORCE");
  const replay = await reconcilePaymentById({
    tenantId: tenant._id,
    paymentId,
    forceReplay: true,
  });
  assert.notEqual(replay.outcome, "EXHAUSTED_REQUIRES_FORCE");
});

test("expiry keeps payment pending when provider is still pending", async () => {
  const { tenant, paymentId, intentId } = await seedPendingGatewayPayment({ mockSuffix: "" });
  await PaymentIntent.updateOne(
    { _id: intentId, tenantId: tenant._id },
    { $set: { reservationExpiresAt: new Date(Date.now() - 60_000) } },
  );
  await runPaymentExpiry();
  assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.PENDING);
});

test("inactive tenant webhook guard rejects unknown or suspended tenants", async () => {
  const { tenant } = await seedTenantUser();
  await Tenant.updateOne({ _id: tenant._id }, { $set: { status: TenantStatus.SUSPENDED } });
  await assert.rejects(
    () => assertWebhookTenantReceivable(tenant._id),
    (error) => error.code === "TENANT_NOT_ACTIVE",
  );
  await assert.rejects(
    () => assertWebhookTenantReceivable(createId("tenant")),
    (error) => error.code === "TENANT_NOT_FOUND",
  );
});

test("refund partial amount creates review alert without reversing payment", async () => {
  const { tenant, paymentId, intentId } = await seedPendingGatewayPayment({
    mockSuffix: "__mock_completed__",
  });
  const intent = await PaymentIntent.findById(intentId).lean();
  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intentId,
    transactionId: `ref_txn_${intentId}`,
    amountPaise: 50_000,
    providerPayload: {},
    webhookEventId: "wh_ref",
    intent,
  });
  const result = await processPhonePeRefundWebhook({
    tenantId: tenant._id,
    type: "PG_REFUND_COMPLETED",
    payload: {
      originalMerchantOrderId: intentId,
      refundId: "ref_partial_1",
      amount: 25_000,
    },
    providerEventId: "pe-ref-partial",
  });
  assert.equal(result.outcome, "PARTIAL_REVIEW");
  assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.SUCCESS);
  const alert = await Alert.findOne({ tenantId: tenant._id, type: "GATEWAY_REFUND_PARTIAL" }).lean();
  assert.ok(alert);
});

test("refund replay is idempotent for full reversal", async () => {
  const { tenant, paymentId, intentId } = await seedPendingGatewayPayment({
    mockSuffix: "__mock_completed__",
  });
  const intent = await PaymentIntent.findById(intentId).lean();
  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intentId,
    transactionId: `full_ref_${intentId}`,
    amountPaise: 50_000,
    providerPayload: {},
    webhookEventId: "wh_full_ref",
    intent,
  });
  const payload = {
    originalMerchantOrderId: intentId,
    refundId: "ref_full_1",
    amount: 50_000,
    currency: "INR",
  };
  const first = await processPhonePeRefundWebhook({
    tenantId: tenant._id,
    type: "PG_REFUND_COMPLETED",
    payload,
    providerEventId: "pe-ref-full",
  });
  assert.equal(first.outcome, "COMPLETED");
  const second = await processPhonePeRefundWebhook({
    tenantId: tenant._id,
    type: "PG_REFUND_COMPLETED",
    payload,
    providerEventId: "pe-ref-full",
  });
  assert.equal(second.outcome, "DUPLICATE");
  assert.equal(await LedgerEntry.countDocuments({ tenantId: tenant._id, paymentId, type: "REVERSAL" }), 1);
  assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.REVERSED);
  assert.equal(
    (await PaymentRefund.findOne({ tenantId: tenant._id, providerRefundId: "ref_full_1" }).lean()).status,
    GatewayRefundStatus.COMPLETED,
  );
});

test("concurrent reconcile completes once without duplicate ledger rows", async () => {
  const { tenant, paymentId } = await seedPendingGatewayPayment({ mockSuffix: "__mock_completed__" });
  const payment = await Payment.findById(paymentId).lean();
  const settled = await Promise.allSettled([
    reconcileGatewayPayment({ ...payment }),
    reconcileGatewayPayment({ ...payment }),
  ]);
  const outcomes = settled.map((row) => (row.status === "fulfilled" ? row.value?.outcome : row.reason?.code));
  assert.ok(outcomes.includes("COMPLETED"));
  assert.equal(await LedgerEntry.countDocuments({ tenantId: tenant._id, paymentId }), 1);
  assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.SUCCESS);
});
