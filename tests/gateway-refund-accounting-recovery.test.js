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
  armMockOrderStatusTemplate,
  clearPhonePeProviderTestHooks,
} from "../src/lib/phonepe-provider-test-hooks.js";
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
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  clearGatewayTxFaults();
  clearPhonePeProviderTestHooks();
});

async function seedPaidPayment({ amountPaise = 50_000 } = {}) {
  const { tenant, branch, user } = await seedTenantUser();
  const customerId = createId("customer");
  await Customer.create({
    _id: customerId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "Recovery",
    mobile: `+9188${String(Date.now()).slice(-8)}`,
  });
  const schemeId = createId("scheme");
  const intentId = createId("paymentIntent");
  armMockOrderStatusTemplate(intentId, "__mock_completed__");
  const paymentId = createId("payment");
  await Scheme.create({
    _id: schemeId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-${Date.now()}`,
    planSnapshot: { paymentPattern: "FIXED", paymentRules: { partialPaymentAllowed: true, minPaymentPaise: 1000 } },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installmentAmountPaise: amountPaise,
    installments: [{ number: 1, dueDate: "2026-01-05", amountPaise, paidPaise: 0, status: "DUE", graceEndsAt: "2026-01-10" }],
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
  return { tenant, paymentId, intentId, amountPaise };
}

function refundArgs(tenantId, intentId, { amount, refundId, providerEventId }) {
  return {
    tenantId,
    type: "PG_REFUND_COMPLETED",
    payload: { originalMerchantOrderId: intentId, refundId, amount, currency: "INR" },
    providerEventId,
  };
}

const FAULTS = [
  "refund:claim-set",
  "refund:ledger-created",
  "refund:scheme-saved",
  "refund:payment-saved",
];

for (const faultLabel of FAULTS) {
  test(`fault at ${faultLabel} rolls back claim and retry completes once`, async () => {
    const { tenant, paymentId, intentId, amountPaise } = await seedPaidPayment();
    const args = refundArgs(tenant._id, intentId, {
      amount: amountPaise,
      refundId: `ref_fault_${faultLabel}`,
      providerEventId: `pe_${faultLabel}`,
    });
    setGatewayTxFaultAfter(faultLabel);
    await assert.rejects(() => processPhonePeRefundWebhook(args));
    const refundRow = await PaymentRefund.findOne({ paymentId }).lean();
    assert.ok(refundRow);
    assert.equal(refundRow.accountingClaimedAt, undefined);
    assert.equal(await LedgerEntry.countDocuments({ paymentId, type: "REVERSAL" }), 0);
    clearGatewayTxFaults();
    const retry = await processPhonePeRefundWebhook(args);
    assert.equal(retry.outcome, "COMPLETED");
    assert.equal(await LedgerEntry.countDocuments({ paymentId, type: "REVERSAL" }), 1);
    assert.equal(await PaymentRefund.countDocuments({ paymentId, status: GatewayRefundStatus.COMPLETED }), 1);
  });
}

test("concurrent retry after fault still yields one reversal", async () => {
  const { tenant, paymentId, intentId, amountPaise } = await seedPaidPayment();
  const args = refundArgs(tenant._id, intentId, {
    amount: amountPaise,
    refundId: "ref_concurrent_retry",
    providerEventId: "pe_concurrent_retry",
  });
  setGatewayTxFaultAfter("refund:scheme-saved");
  await assert.rejects(() => processPhonePeRefundWebhook(args));
  clearGatewayTxFaults();
  const settled = await Promise.allSettled([
    processPhonePeRefundWebhook(args),
    processPhonePeRefundWebhook(args),
  ]);
  const completed = settled.filter((r) => r.status === "fulfilled" && r.value?.outcome === "COMPLETED").length;
  assert.equal(completed, 1);
  assert.equal(await LedgerEntry.countDocuments({ paymentId, type: "REVERSAL" }), 1);
});

test("completed refund cannot be reclaimed", async () => {
  const { tenant, paymentId, intentId, amountPaise } = await seedPaidPayment();
  const args = refundArgs(tenant._id, intentId, {
    amount: amountPaise,
    refundId: "ref_done",
    providerEventId: "pe_done",
  });
  await processPhonePeRefundWebhook(args);
  const replay = await processPhonePeRefundWebhook(args);
  assert.equal(replay.outcome, "DUPLICATE");
  await PaymentRefund.updateOne({ paymentId }, { $unset: { accountingClaimedAt: "" } });
  const again = await processPhonePeRefundWebhook({
    ...args,
    providerEventId: "pe_done_reclaim_try",
  });
  assert.equal(again.outcome, "DUPLICATE");
  assert.equal(await LedgerEntry.countDocuments({ paymentId, type: "REVERSAL" }), 1);
});

test("stale manual accountingClaimedAt without ledger is reclaimed once", async () => {
  const { tenant, paymentId, intentId, amountPaise } = await seedPaidPayment();
  await PaymentRefund.create({
    _id: createId("pref"),
    tenantId: tenant._id,
    paymentId,
    providerRefundId: "ref_stale",
    providerEventId: "pe_stale_seed",
    amountPaise,
    status: GatewayRefundStatus.PENDING,
    accountingClaimedAt: new Date("2020-01-01"),
  });
  const result = await processPhonePeRefundWebhook(refundArgs(tenant._id, intentId, {
    amount: amountPaise,
    refundId: "ref_stale",
    providerEventId: "pe_stale_complete",
  }));
  assert.equal(result.outcome, "COMPLETED");
  assert.equal(await LedgerEntry.countDocuments({ paymentId, type: "REVERSAL" }), 1);
});
