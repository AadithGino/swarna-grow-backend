import {
  EcommerceOrderCancellationRequestStatus,
  EcommerceOrderStatus,
  EcommercePaymentAttemptOperationalStatus,
  EcommercePaymentMethod,
} from "../constants/enums.js";
import { orderUsesCod } from "./ecommerce-cod.js";
import { isCourierCodCollectionConfirmed } from "./ecommerce-courier-cod.js";

const SHIPPED_OR_LATER = new Set([
  EcommerceOrderStatus.SHIPPED,
  EcommerceOrderStatus.DELIVERED,
]);

const CUSTOMER_DIRECT_STATUSES = new Set([
  EcommerceOrderStatus.PENDING_PAYMENT,
  EcommerceOrderStatus.COD_PENDING_ACCEPTANCE,
]);

const CUSTOMER_REQUEST_STATUSES = new Set([
  EcommerceOrderStatus.PAID,
  EcommerceOrderStatus.PROCESSING,
  EcommerceOrderStatus.READY_FOR_PICKUP,
]);

const ADMIN_CANCEL_BEFORE_SHIP_STATUSES = new Set([
  EcommerceOrderStatus.PAID,
  EcommerceOrderStatus.PROCESSING,
  EcommerceOrderStatus.READY_FOR_PICKUP,
]);

export function isShippedOrDelivered(status) {
  return SHIPPED_OR_LATER.has(status);
}

export function customerDirectCancelEligible(order, { paymentInFlightBlocked }) {
  if (!CUSTOMER_DIRECT_STATUSES.has(order.status)) {
    return { allowed: false, code: "ORDER_NOT_DIRECTLY_CANCELLABLE" };
  }
  if (order.status === EcommerceOrderStatus.PENDING_PAYMENT && paymentInFlightBlocked) {
    return { allowed: false, code: "PAYMENT_IN_FLIGHT" };
  }
  if (order.activeCancellationRequestId) {
    return { allowed: false, code: "CANCELLATION_ALREADY_OPEN" };
  }
  return { allowed: true };
}

export function customerCancellationRequestEligible(order) {
  if (isShippedOrDelivered(order.status)) {
    return { allowed: false, code: "CONTACT_STORE_FOR_RETURN" };
  }
  if (!CUSTOMER_REQUEST_STATUSES.has(order.status)) {
    return { allowed: false, code: "ORDER_NOT_REQUEST_CANCELLABLE" };
  }
  if (order.activeCancellationRequestId) {
    return { allowed: false, code: "CANCELLATION_ALREADY_OPEN" };
  }
  if (order.status === EcommerceOrderStatus.REFUND_PENDING) {
    return { allowed: false, code: "REFUND_IN_PROGRESS" };
  }
  return { allowed: true };
}

export function adminCancellationEligible(order) {
  if (isShippedOrDelivered(order.status)) {
    return { allowed: false, code: "CONTACT_STORE_FOR_RETURN" };
  }
  if (!ADMIN_CANCEL_BEFORE_SHIP_STATUSES.has(order.status)) {
    return { allowed: false, code: "ORDER_NOT_ADMIN_CANCELLABLE" };
  }
  if (order.activeCancellationRequestId) {
    return { allowed: false, code: "CANCELLATION_ALREADY_OPEN" };
  }
  return { allowed: true };
}

export function paymentAttemptBlocksCustomerCancel(attempt) {
  if (!attempt) return false;
  const op = attempt.operationalStatus;
  if (
    op === EcommercePaymentAttemptOperationalStatus.INITIATION_UNCERTAIN
    || op === EcommercePaymentAttemptOperationalStatus.AWAITING_PROVIDER
    || op === EcommercePaymentAttemptOperationalStatus.STUCK_RECONCILE
  ) {
    return true;
  }
  return Boolean(attempt.providerOrderId || attempt.status === "INITIATED");
}

export function cancellationNeedsOnlineRefund(order) {
  return (
    (order.paymentMethod ?? EcommercePaymentMethod.ONLINE) === EcommercePaymentMethod.ONLINE
    && order.status !== EcommerceOrderStatus.COD_PENDING_ACCEPTANCE
    && Boolean(order.paidAt || order.successfulPaymentAttemptId)
  );
}

export function cancellationNeedsCodManualRefund(order) {
  return orderUsesCod(order) && isCourierCodCollectionConfirmed(order);
}

export function activeCancellationStatuses() {
  return [
    EcommerceOrderCancellationRequestStatus.PENDING_DECISION,
    EcommerceOrderCancellationRequestStatus.APPROVED_PROCESSING,
  ];
}
