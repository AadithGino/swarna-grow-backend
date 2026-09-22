import test from "node:test";
import assert from "node:assert/strict";
import {
  GatewayRefundStatus,
  PaymentIntentStatus,
  PaymentMode,
  PaymentStatus,
} from "../src/constants/enums.js";
import { clearGatewayTxFaults, setGatewayTxFaultAfter } from "../src/lib/gateway-tx-faults.js";
import {
  Alert,
  Customer,
  LedgerEntry,
  Payment,
  PaymentIntent,
  PaymentRefund,
  Scheme,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import {
  finalizeGatewaySuccess,
  GatewayFinalizeOutcome,
} from "../src/services/finalize-gateway-success.service.js";
import { processPhonePeRefundWebhook } from "../src/services/phonepe-refund.service.js";
import { today } from "../src/lib/date.js";
import { setGoldRate } from "../src/services/tenant.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  clearGatewayTxFaults();
});

async function seedPaidGatewayPayment({
  amountPaise = 100_000,
  weightMg = 1000,
  valueBasis = "CASH",
} = {}) {
  const { tenant, branch, user } = await seedTenantUser();
  const customerId = createId("customer");
  await Customer.create({
    _id: customerId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "Refund Test",
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
      paymentRules: { partialPaymentAllowed: true, advancePaymentAllowed: false, maxAdvanceInstallments: 0, minPaymentPaise: 1000 },
    },
    valueBasis,
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
    weightMg: valueBasis === "GOLD_WEIGHT" ? weightMg : 0,
    ratePerGramPaise: valueBasis === "GOLD_WEIGHT" ? 500_000 : undefined,
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
  if (valueBasis === "GOLD_WEIGHT") {
    await setGoldRate({
      auth: { id: user._id, tenantId: tenant._id },
      headers: { "user-agent": "test" },
      body: {
        effectiveDate: today(),
        ratePerGramPaise: 500_000,
        branchId: branch._id,
      },
    });
  }
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
  return { tenant, paymentId, intentId, schemeId, amountPaise, weightMg };
}

test("25% then remaining 75% partial refunds persist ledger and scheme totals", async () => {
  const { tenant, paymentId, intentId, schemeId, amountPaise } = await seedPaidGatewayPayment();
  const first = await processPhonePeRefundWebhook({
    tenantId: tenant._id,
    type: "PG_REFUND_COMPLETED",
    payload: {
      originalMerchantOrderId: intentId,
      refundId: "ref_q1",
      amount: 25_000,
    },
    providerEventId: "pe-ref-q1",
  });
  assert.equal(first.outcome, "COMPLETED");
  let payment = await Payment.findById(paymentId).lean();
  assert.equal(payment.status, PaymentStatus.PARTIALLY_REFUNDED);
  assert.equal(payment.refundedAmountPaise, 25_000);
  assert.equal(await LedgerEntry.countDocuments({ paymentId, type: "REVERSAL" }), 1);
  let scheme = await Scheme.findById(schemeId).lean();
  assert.equal(scheme.installments[0].paidPaise, 75_000);

  const second = await processPhonePeRefundWebhook({
    tenantId: tenant._id,
    type: "PG_REFUND_COMPLETED",
    payload: {
      originalMerchantOrderId: intentId,
      refundId: "ref_q2",
      amount: 75_000,
    },
    providerEventId: "pe-ref-q2",
  });
  assert.equal(second.outcome, "COMPLETED");
  payment = await Payment.findById(paymentId).lean();
  assert.equal(payment.status, PaymentStatus.REVERSED);
  assert.equal(payment.refundedAmountPaise, amountPaise);
  assert.equal(await LedgerEntry.countDocuments({ paymentId, type: "REVERSAL" }), 2);
  scheme = await Scheme.findById(schemeId).lean();
  assert.equal(scheme.installments[0].paidPaise, 0);
});

test("three uneven partial refunds stay within original amount", async () => {
  const { tenant, paymentId, intentId } = await seedPaidGatewayPayment({ amountPaise: 90_000 });
  for (const [idx, amount] of [[1, 20_000], [2, 35_000], [3, 35_000]]) {
    const result = await processPhonePeRefundWebhook({
      tenantId: tenant._id,
      type: "PG_REFUND_COMPLETED",
      payload: { originalMerchantOrderId: intentId, refundId: `ref_${idx}`, amount },
      providerEventId: `pe-${idx}`,
    });
    assert.equal(result.outcome, "COMPLETED");
  }
  const payment = await Payment.findById(paymentId).lean();
  assert.equal(payment.refundedAmountPaise, 90_000);
  assert.equal(await LedgerEntry.countDocuments({ paymentId, type: "REVERSAL" }), 3);
});

test("duplicate and concurrent refund callbacks stay idempotent", async () => {
  const { tenant, paymentId, intentId, amountPaise } = await seedPaidGatewayPayment({ amountPaise: 50_000 });
  const args = {
    tenantId: tenant._id,
    type: "PG_REFUND_COMPLETED",
    payload: {
      originalMerchantOrderId: intentId,
      refundId: "ref_dup",
      amount: amountPaise,
    },
    providerEventId: "pe-dup",
  };
  const settled = await Promise.allSettled([
    processPhonePeRefundWebhook(args),
    processPhonePeRefundWebhook(args),
  ]);
  assert.equal(await LedgerEntry.countDocuments({ paymentId, type: "REVERSAL" }), 1);
  const outcomes = settled.filter((r) => r.status === "fulfilled").map((r) => r.value.outcome);
  assert.ok(outcomes.includes("COMPLETED"));
  assert.ok(outcomes.includes("DUPLICATE") || outcomes.filter((o) => o === "COMPLETED").length === 1);
});

test("concurrent different partial refunds cannot over-refund", async () => {
  const { tenant, paymentId, intentId } = await seedPaidGatewayPayment({ amountPaise: 50_000 });
  const a = processPhonePeRefundWebhook({
    tenantId: tenant._id,
    type: "PG_REFUND_COMPLETED",
    payload: { originalMerchantOrderId: intentId, refundId: "ref_a", amount: 30_000 },
    providerEventId: "pe-a",
  });
  const b = processPhonePeRefundWebhook({
    tenantId: tenant._id,
    type: "PG_REFUND_COMPLETED",
    payload: { originalMerchantOrderId: intentId, refundId: "ref_b", amount: 30_000 },
    providerEventId: "pe-b",
  });
  const settled = await Promise.allSettled([a, b]);
  const outcomes = settled
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value.outcome);
  assert.ok(outcomes.includes("COMPLETED"));
  assert.ok(outcomes.includes("EXCEEDS_REMAINING"));
  const payment = await Payment.findById(paymentId).lean();
  assert.equal(payment.refundedAmountPaise, 30_000);
  const reversals = await LedgerEntry.find({ paymentId, type: "REVERSAL" }).lean();
  const sum = reversals.reduce((s, row) => s + row.amountPaise, 0);
  assert.equal(sum, payment.refundedAmountPaise);
  assert.equal(await LedgerEntry.countDocuments({ paymentId, type: "REVERSAL" }), 1);
});

test("FAILED after COMPLETED does not corrupt accounting", async () => {
  const { tenant, paymentId, intentId } = await seedPaidGatewayPayment({ amountPaise: 40_000 });
  await processPhonePeRefundWebhook({
    tenantId: tenant._id,
    type: "PG_REFUND_COMPLETED",
    payload: { originalMerchantOrderId: intentId, refundId: "ref_f", amount: 40_000 },
    providerEventId: "pe-ok",
  });
  const failed = await processPhonePeRefundWebhook({
    tenantId: tenant._id,
    type: "PG_REFUND_FAILED",
    payload: { originalMerchantOrderId: intentId, refundId: "ref_f" },
    providerEventId: "pe-fail",
  });
  assert.equal(failed.outcome, "ALREADY_COMPLETED");
  assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.REVERSED);
  assert.equal(await LedgerEntry.countDocuments({ paymentId, type: "REVERSAL" }), 1);
});

test("gold-weight partial refund reverses proportional mg with exact remainder", async () => {
  const { tenant, paymentId, intentId } = await seedPaidGatewayPayment({
    amountPaise: 100_000,
    weightMg: 1000,
    valueBasis: "GOLD_WEIGHT",
  });
  let payment = await Payment.findById(paymentId).lean();
  const allocatedWeightMg = payment.weightMg;
  assert.ok(allocatedWeightMg > 0);
  await processPhonePeRefundWebhook({
    tenantId: tenant._id,
    type: "PG_REFUND_COMPLETED",
    payload: { originalMerchantOrderId: intentId, refundId: "gw1", amount: 25_000 },
    providerEventId: "pe-gw1",
  });
  payment = await Payment.findById(paymentId).lean();
  assert.equal(payment.refundedWeightMg, Math.floor((allocatedWeightMg * 25_000) / 100_000));
  await processPhonePeRefundWebhook({
    tenantId: tenant._id,
    type: "PG_REFUND_COMPLETED",
    payload: { originalMerchantOrderId: intentId, refundId: "gw2", amount: 75_000 },
    providerEventId: "pe-gw2",
  });
  payment = await Payment.findById(paymentId).lean();
  assert.equal(payment.refundedWeightMg, allocatedWeightMg);
});

test("refund transaction rollback leaves no partial ledger state", async () => {
  const { tenant, paymentId, intentId } = await seedPaidGatewayPayment();
  setGatewayTxFaultAfter("refund:scheme-saved");
  await assert.rejects(() => processPhonePeRefundWebhook({
    tenantId: tenant._id,
    type: "PG_REFUND_COMPLETED",
    payload: { originalMerchantOrderId: intentId, refundId: "rb", amount: 10_000 },
    providerEventId: "pe-rb",
  }));
  assert.equal(await LedgerEntry.countDocuments({ paymentId, type: "REVERSAL" }), 0);
  assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.SUCCESS);
  assert.equal(await PaymentRefund.countDocuments({ paymentId, status: GatewayRefundStatus.COMPLETED }), 0);
  assert.equal(await Alert.countDocuments({ tenantId: tenant._id, type: "GATEWAY_REFUND_INVALID" }), 0);
});
