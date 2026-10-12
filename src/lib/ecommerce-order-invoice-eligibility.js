import {
  EcommerceOrderStatus,
} from "../constants/enums.js";

const INVOICE_UNAVAILABLE_STATUSES = new Set([
  EcommerceOrderStatus.PENDING_PAYMENT,
  EcommerceOrderStatus.PAYMENT_EXPIRED,
  EcommerceOrderStatus.PAYMENT_FAILED,
  EcommerceOrderStatus.COD_PENDING_ACCEPTANCE,
  EcommerceOrderStatus.CANCELLED,
]);

export function isEcommerceOrderInvoiceAvailable(order) {
  if (!order?.status) return false;
  return !INVOICE_UNAVAILABLE_STATUSES.has(order.status);
}
