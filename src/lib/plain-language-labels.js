/**
 * Plain-language display labels for stored enum/status codes.
 * Never mutates persisted values — map at DTO boundaries only.
 */

/** Glossary terms for admin/customer copy (stored codes unchanged). */
export const PLAIN_LANGUAGE_GLOSSARY = Object.freeze({
  PAYABLE: "Amount owed",
  SETTLEMENT: "Payment recorded",
  PHYSICAL_OUT: "Metal handed over",
  REMITTANCE: "Courier payment",
});

const SELL_ORDER_STATUS = Object.freeze({
  RESERVED: "Quote reserved",
  PENDING_APPROVAL: "Previous request needs review",
  PAYABLE_OPEN: "Payment pending",
  EXECUTED: "Sale accepted",
  CANCELLED: "Cancelled",
  EXPIRED: "Quote expired",
});

const ECOMMERCE_ORDER_STATUS = Object.freeze({
  PENDING_PAYMENT: "Awaiting payment",
  PAYMENT_EXPIRED: "Payment window expired",
  PAYMENT_FAILED: "Payment failed",
  COD_PENDING_ACCEPTANCE: "Awaiting store acceptance",
  PAID: "Paid",
  PROCESSING: "Preparing order",
  READY_FOR_PICKUP: "Ready for pickup",
  SHIPPED: "Shipped",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
  REFUND_PENDING: "Refund in progress",
  REFUNDED: "Refunded",
});

const COD_REMITTANCE_STATUS = Object.freeze({
  NOT_APPLICABLE: "Not applicable",
  NOT_DUE: "Courier payment not due",
  OWED: "Courier payment pending",
  BATCH_PENDING: "Courier payment in batch",
  BANK_RECONCILED: "Courier payment received",
  DISCREPANCY: "Courier payment discrepancy",
});

export function plainLanguageSellOrderStatus(status) {
  const key = String(status ?? "").trim();
  return SELL_ORDER_STATUS[key] ?? null;
}

export function plainLanguageEcommerceOrderStatus(status) {
  const key = String(status ?? "").trim();
  return ECOMMERCE_ORDER_STATUS[key] ?? null;
}

/** Display-only mapping; persisted `PROCESSING` and legacy transitions remain valid. */
export function plainLanguageEcommerceOrderStatusForOrder(status, fulfilmentMode) {
  const key = String(status ?? "").trim();
  if (key === "DELIVERED" && String(fulfilmentMode ?? "") === "BRANCH_PICKUP") {
    return "Collected";
  }
  return plainLanguageEcommerceOrderStatus(key);
}

export function plainLanguageCourierRemittanceStatus(status) {
  const key = String(status ?? "").trim();
  return COD_REMITTANCE_STATUS[key] ?? null;
}

/**
 * Customer-facing payment dimension for COD (stored enums unchanged).
 * Prefer {@link codCustomerPaymentEvidence} on order rows (shipped/delivered included).
 */
export function plainLanguageCodCustomerPaidLabel({ collectionConfirmed, label }) {
  if (label) return label;
  return collectionConfirmed ? "Customer paid" : "Payment unconfirmed";
}

export function plainLanguageCodCourierPaymentLabel(remittanceStatus) {
  const mapped = plainLanguageCourierRemittanceStatus(remittanceStatus);
  if (mapped) return mapped;
  return "Courier payment pending";
}

export function withDisplayStatus(dto, status, mapper = plainLanguageEcommerceOrderStatus) {
  const displayStatusLabel = mapper(status) ?? String(status ?? "").replaceAll("_", " ").toLowerCase();
  return { ...dto, displayStatusLabel };
}
