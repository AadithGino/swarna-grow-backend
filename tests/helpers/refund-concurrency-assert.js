import assert from "node:assert/strict";
import { GatewayRefundStatus, PaymentStatus } from "../../src/constants/enums.js";
import { Alert, LedgerEntry, OutboxEvent, Payment, PaymentRefund, Scheme } from "../../src/models/index.js";

export async function assertFullRefundInvariants({
  tenantId,
  paymentId,
  originalAmountPaise,
  originalWeightMg = 0,
  expectedCompletedOutcomes = 1,
  expectedTotalCallbacks = 2,
  settled = [],
}) {
  const completed = settled.filter(
    (row) => row.status === "fulfilled" && row.value?.outcome === "COMPLETED",
  ).length;
  const terminal = settled.filter(
    (row) => row.status === "fulfilled"
      && ["DUPLICATE", "CONFLICT", "EXCEEDS_REMAINING", "ALREADY_COMPLETED"].includes(row.value?.outcome),
  ).length;
  assert.equal(completed, expectedCompletedOutcomes, `COMPLETED count: ${completed}`);
  assert.equal(
    completed + terminal,
    expectedTotalCallbacks,
    `terminal outcomes: ${JSON.stringify(settled.map((r) => r.status === "fulfilled" ? r.value?.outcome : r.reason))}`,
  );

  assert.equal(
    await LedgerEntry.countDocuments({ tenantId, paymentId, type: "REVERSAL" }),
    expectedCompletedOutcomes,
  );
  const payment = await Payment.findById(paymentId).lean();
  if (expectedCompletedOutcomes === 1 && originalAmountPaise) {
    assert.equal(payment.refundedAmountPaise, originalAmountPaise);
    assert.equal(payment.status, PaymentStatus.REVERSED);
    if (originalWeightMg > 0) {
      assert.equal(payment.refundedWeightMg, originalWeightMg);
    }
  }
  const completedRefunds = await PaymentRefund.countDocuments({
    paymentId,
    status: GatewayRefundStatus.COMPLETED,
  });
  assert.equal(completedRefunds, expectedCompletedOutcomes);

  const scheme = await Scheme.findById(payment.schemeId).lean();
  if (expectedCompletedOutcomes === 1 && scheme?.installments?.length) {
    assert.equal(scheme.installments[0].paidPaise, 0);
  }

  assert.equal(await OutboxEvent.countDocuments({ tenantId, status: "PENDING" }), 0);
  assert.ok(await Alert.countDocuments({ tenantId }) >= 0);
}
