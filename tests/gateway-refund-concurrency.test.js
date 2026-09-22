import test from "node:test";
import assert from "node:assert/strict";
import {
  GatewayRefundStatus,
  PaymentIntentStatus,
  PaymentMode,
  PaymentStatus,
} from "../src/constants/enums.js";
import { clearGatewayTxFaults, setGatewayTxFaultAfter } from "../src/lib/gateway-tx-faults.js";
import { createId } from "../src/lib/ids.js";
import {
  finalizeGatewaySuccess,
  GatewayFinalizeOutcome,
} from "../src/services/finalize-gateway-success.service.js";
import { processPhonePeRefundWebhook } from "../src/services/phonepe-refund.service.js";
import {
  Customer,
  LedgerEntry,
  Payment,
  PaymentIntent,
  PaymentRefund,
  Scheme,
} from "../src/models/index.js";
import { assertFullRefundInvariants } from "./helpers/refund-concurrency-assert.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  clearGatewayTxFaults();
});

async function seedPaidPayment({ amountPaise = 50_000, weightMg = 0 } = {}) {
  const { tenant, branch, user } = await seedTenantUser();
  const customerId = createId("customer");
  await Customer.create({
    _id: customerId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "Refund Concurrency",
    mobile: `+9188${String(Date.now()).slice(-8)}`,
  });
  const schemeId = createId("scheme");
  const intentId = `${createId("paymentIntent")}__mock_completed__`;
  const paymentId = createId("payment");
  await Scheme.create({
    _id: schemeId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      paymentRules: { partialPaymentAllowed: true, minPaymentPaise: 1000 },
    },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installmentAmountPaise: amountPaise,
    installments: [{
      number: 1,
      dueDate: "2026-01-05",
      amountPaise,
      paidPaise: 0,
      status: "DUE",
      graceEndsAt: "2026-01-10",
    }],
    positionVersion: 1,
    version: 1,
    createdBy: user._id,
  });
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId,
    customerId,
    receiptNumber: `PENDING-${intentId}`,
    amountPaise,
    weightMg,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
  });
  await PaymentIntent.create({
    _id: intentId,
    tenantId: tenant._id,
    branchId: branch._id,
    paymentId,
    schemeId,
    customerId,
    amountPaise,
    positionVersion: 1,
    status: PaymentIntentStatus.PENDING,
    version: 1,
  });
  const intent = await PaymentIntent.findById(intentId).lean();
  const fin = await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intentId,
    transactionId: `txn_${intentId}`,
    amountPaise,
    providerPayload: {},
    webhookEventId: `wh_${intentId}`,
    intent,
  });
  assert.equal(fin.outcome, GatewayFinalizeOutcome.SUCCESS);
  return { tenant, paymentId, intentId, amountPaise, weightMg };
}

function refundArgs(tenantId, intentId, { amount, refundId, providerEventId }) {
  return {
    tenantId,
    type: "PG_REFUND_COMPLETED",
    payload: {
      originalMerchantOrderId: intentId,
      refundId,
      amount,
      currency: "INR",
    },
    providerEventId,
  };
}

async function runConcurrentFullRefundScenario() {
  const { tenant, paymentId, intentId, amountPaise } = await seedPaidPayment();
  const args = refundArgs(tenant._id, intentId, {
    amount: amountPaise,
    refundId: "ref_same_full",
    providerEventId: "pe-same-full",
  });
  const settled = await Promise.allSettled([
    processPhonePeRefundWebhook(args),
    processPhonePeRefundWebhook(args),
  ]);
  await assertFullRefundInvariants({
    tenantId: tenant._id,
    paymentId,
    originalAmountPaise: amountPaise,
    settled,
    expectedCompletedOutcomes: 1,
    expectedTotalCallbacks: 2,
  });
}

test("two concurrent identical full-refund callbacks converge to one reversal", async () => {
  await runConcurrentFullRefundScenario();
});

test("identical full-refund concurrency stable for 25 sequential runs", async () => {
  for (let i = 0; i < 25; i += 1) {
    await resetTestDb();
    clearGatewayTxFaults();
    await runConcurrentFullRefundScenario();
  }
});

test("ten concurrent identical full-refund callbacks converge to one reversal", async () => {
  const { tenant, paymentId, intentId, amountPaise } = await seedPaidPayment();
  const args = refundArgs(tenant._id, intentId, {
    amount: amountPaise,
    refundId: "ref_ten",
    providerEventId: "pe-ten",
  });
  const settled = await Promise.allSettled(
    Array.from({ length: 10 }, () => processPhonePeRefundWebhook(args)),
  );
  await assertFullRefundInvariants({
    tenantId: tenant._id,
    paymentId,
    originalAmountPaise: amountPaise,
    settled,
    expectedCompletedOutcomes: 1,
    expectedTotalCallbacks: 10,
  });
});

test("partial callback racing full callback keeps accounting bounded", async () => {
  const { tenant, paymentId, intentId, amountPaise } = await seedPaidPayment({ amountPaise: 100_000 });
  const partial = refundArgs(tenant._id, intentId, {
    amount: 25_000,
    refundId: "ref_partial",
    providerEventId: "pe-partial-race",
  });
  const full = refundArgs(tenant._id, intentId, {
    amount: 100_000,
    refundId: "ref_full",
    providerEventId: "pe-full-race",
  });
  await Promise.allSettled([
    processPhonePeRefundWebhook(partial),
    processPhonePeRefundWebhook(full),
  ]);
  const payment = await Payment.findById(paymentId).lean();
  assert.ok(payment.refundedAmountPaise <= amountPaise);
  assert.ok(await LedgerEntry.countDocuments({ paymentId, type: "REVERSAL" }) <= 2);
});

test("two different provider refund IDs racing beyond remaining cannot over-refund", async () => {
  const { tenant, paymentId, intentId } = await seedPaidPayment({ amountPaise: 50_000 });
  await Promise.allSettled([
    processPhonePeRefundWebhook(refundArgs(tenant._id, intentId, {
      amount: 30_000,
      refundId: "ref_a",
      providerEventId: "pe-a",
    })),
    processPhonePeRefundWebhook(refundArgs(tenant._id, intentId, {
      amount: 30_000,
      refundId: "ref_b",
      providerEventId: "pe-b",
    })),
  ]);
  const payment = await Payment.findById(paymentId).lean();
  assert.equal(payment.refundedAmountPaise, 30_000);
  assert.equal(await LedgerEntry.countDocuments({ paymentId, type: "REVERSAL" }), 1);
});

test("replay after completed refund is DUPLICATE", async () => {
  const { tenant, paymentId, intentId, amountPaise } = await seedPaidPayment();
  const args = refundArgs(tenant._id, intentId, {
    amount: amountPaise,
    refundId: "ref_replay",
    providerEventId: "pe-replay",
  });
  const first = await processPhonePeRefundWebhook(args);
  assert.equal(first.outcome, "COMPLETED");
  const second = await processPhonePeRefundWebhook(args);
  assert.equal(second.outcome, "DUPLICATE");
  assert.equal(await LedgerEntry.countDocuments({ paymentId, type: "REVERSAL" }), 1);
});

test("FAILED after COMPLETED does not corrupt accounting", async () => {
  const { tenant, paymentId, intentId, amountPaise } = await seedPaidPayment();
  await processPhonePeRefundWebhook(refundArgs(tenant._id, intentId, {
    amount: amountPaise,
    refundId: "ref_ok",
    providerEventId: "pe-ok",
  }));
  const failed = await processPhonePeRefundWebhook({
    tenantId: tenant._id,
    type: "PG_REFUND_FAILED",
    payload: { originalMerchantOrderId: intentId, refundId: "ref_ok" },
    providerEventId: "pe-fail-after",
  });
  assert.equal(failed.outcome, "ALREADY_COMPLETED");
  assert.equal((await Payment.findById(paymentId).lean()).refundedAmountPaise, amountPaise);
});

test("injected fault after payment update rolls back refund accounting", async () => {
  const { tenant, paymentId, intentId, amountPaise } = await seedPaidPayment();
  setGatewayTxFaultAfter("refund:payment-saved");
  await assert.rejects(() => processPhonePeRefundWebhook(refundArgs(tenant._id, intentId, {
    amount: amountPaise,
    refundId: "ref_fault",
    providerEventId: "pe-fault",
  })));
  assert.equal(await LedgerEntry.countDocuments({ paymentId, type: "REVERSAL" }), 0);
  assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.SUCCESS);
  assert.equal(await PaymentRefund.countDocuments({ paymentId, status: GatewayRefundStatus.COMPLETED }), 0);
});
