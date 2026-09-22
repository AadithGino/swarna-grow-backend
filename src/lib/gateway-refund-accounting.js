import Decimal from "decimal.js";
import { assertInteger } from "./money.js";

/** Cumulative reversed gold weight for a partial/full refund total (floor ratio). */
export function cumulativeRefundWeightMg({
  originalPaymentWeightMg = 0,
  originalPaymentAmountPaise,
  cumulativeRefundPaise,
}) {
  const weightMg = assertInteger(originalPaymentWeightMg ?? 0, "originalPaymentWeightMg");
  const amountPaise = assertInteger(originalPaymentAmountPaise, "originalPaymentAmountPaise");
  const refundPaise = assertInteger(cumulativeRefundPaise, "cumulativeRefundPaise");
  if (refundPaise <= 0) return 0;
  if (amountPaise <= 0) return 0;
  if (refundPaise >= amountPaise) return weightMg;
  return new Decimal(weightMg)
    .mul(refundPaise)
    .div(amountPaise)
    .floor()
    .toNumber();
}

/** Weight delta for this refund increment given prior cumulative reversed weight. */
export function refundWeightDeltaMg({
  originalPaymentWeightMg = 0,
  originalPaymentAmountPaise,
  priorRefundedAmountPaise,
  priorRefundedWeightMg = 0,
  refundAmountPaise,
}) {
  const priorAmount = assertInteger(priorRefundedAmountPaise ?? 0, "priorRefundedAmountPaise");
  const priorWeight = assertInteger(priorRefundedWeightMg ?? 0, "priorRefundedWeightMg");
  const deltaPaise = assertInteger(refundAmountPaise, "refundAmountPaise");
  const cumulativePaise = priorAmount + deltaPaise;
  const targetCumulative = cumulativeRefundWeightMg({
    originalPaymentWeightMg,
    originalPaymentAmountPaise,
    cumulativeRefundPaise: cumulativePaise,
  });
  const remainingWeight = assertInteger(originalPaymentWeightMg ?? 0, "originalPaymentWeightMg") - priorWeight;
  const deltaWeight = targetCumulative - priorWeight;
  if (cumulativePaise >= originalPaymentAmountPaise) {
    return Math.max(0, remainingWeight);
  }
  return Math.max(0, deltaWeight);
}
