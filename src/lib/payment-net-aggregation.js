import { PaymentStatus } from "../constants/enums.js";

/** Settled payment statuses that contribute net collections (after refunds). */
export const NET_COLLECTION_PAYMENT_STATUSES = [
  PaymentStatus.SUCCESS,
  PaymentStatus.PARTIALLY_REFUNDED,
];

export function netCollectionStatusFilter() {
  return { status: { $in: NET_COLLECTION_PAYMENT_STATUSES } };
}

/** Financial history rows: collected payments plus fully reversed (audit visibility). */
export function paymentFinancialHistoryStatusFilter() {
  return {
    status: { $in: [...NET_COLLECTION_PAYMENT_STATUSES, PaymentStatus.REVERSED] },
  };
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

/** Shared gross / refunded / net fields for customer and staff payment DTOs. */
export function paymentNetFieldsFromDoc(payment) {
  const grossAmountPaise = Number(payment?.amountPaise ?? 0);
  const refundedAmountPaise = Number(payment?.refundedAmountPaise ?? 0);
  const netAmountPaise = netAmountPaiseFromDoc(payment);
  const grossWeightMg = Number(payment?.weightMg ?? 0);
  const refundedWeightMg = Number(payment?.refundedWeightMg ?? 0);
  const netWeightMg = netWeightMgFromDoc(payment);
  return {
    grossAmountPaise,
    refundedAmountPaise,
    netAmountPaise,
    grossWeightMg,
    refundedWeightMg,
    netWeightMg,
    status: payment?.status ?? null,
  };
}

export function isPositiveNetContributionPayment(payment) {
  if (!NET_COLLECTION_PAYMENT_STATUSES.includes(payment?.status)) return false;
  return netAmountPaiseFromDoc(payment) > 0;
}

/** Staff/admin DTO fields: legacy `amount` reflects net retained. */
export function paymentNetMoneyRefs(payment) {
  const net = paymentNetFieldsFromDoc(payment);
  return {
    grossAmountPaise: net.grossAmountPaise,
    refundedAmountPaise: net.refundedAmountPaise,
    netAmountPaise: net.netAmountPaise,
    grossWeightMg: net.grossWeightMg,
    refundedWeightMg: net.refundedWeightMg,
    netWeightMg: net.netWeightMg,
  };
}
