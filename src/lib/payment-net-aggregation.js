import { PaymentStatus } from "../constants/enums.js";

/** Settled payment statuses that contribute net collections (after refunds). */
export const NET_COLLECTION_PAYMENT_STATUSES = [
  PaymentStatus.SUCCESS,
  PaymentStatus.PARTIALLY_REFUNDED,
];

export function netCollectionStatusFilter() {
  return { status: { $in: NET_COLLECTION_PAYMENT_STATUSES } };
}

/** Mongo aggregation expression: max(0, amountPaise - refundedAmountPaise). */
export function netAmountPaiseExpression() {
  return {
    $max: [
      0,
      {
        $subtract: [
          { $ifNull: ["$amountPaise", 0] },
          { $ifNull: ["$refundedAmountPaise", 0] },
        ],
      },
    ],
  };
}

/** Mongo aggregation expression: max(0, weightMg - refundedWeightMg). */
export function netWeightMgExpression() {
  return {
    $max: [
      0,
      {
        $subtract: [
          { $ifNull: ["$weightMg", 0] },
          { $ifNull: ["$refundedWeightMg", 0] },
        ],
      },
    ],
  };
}

export function sumNetAmountPaise() {
  return { $sum: netAmountPaiseExpression() };
}

export function sumNetWeightMg() {
  return { $sum: netWeightMgExpression() };
}

export function netAmountPaiseFromDoc(payment) {
  return Math.max(
    0,
    Number(payment?.amountPaise ?? 0) - Number(payment?.refundedAmountPaise ?? 0),
  );
}

export function netWeightMgFromDoc(payment) {
  return Math.max(
    0,
    Number(payment?.weightMg ?? 0) - Number(payment?.refundedWeightMg ?? 0),
  );
}
