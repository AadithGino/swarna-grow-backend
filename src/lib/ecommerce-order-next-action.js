import { EcommerceOrderStatus } from "../constants/enums.js";
import { plainLanguageEcommerceOrderStatus } from "./plain-language-labels.js";

/**
 * Single suggested staff action for ecommerce order detail/lists (display only).
 */
export function computeEcommerceOrderNextAction(order) {
  const id = order._id ?? order.id;
  const href = `/ecommerce/orders/${id}`;
  const status = order.status;
  const mode = order.fulfilmentMode ?? "BRANCH_PICKUP";

  if (order.paymentExceptionStatus) {
    return { key: "FIX_PAYMENT", label: "Fix payment", href };
  }
  if (order.activeCancellationRequestId) {
    return { key: "REVIEW_CANCELLATION", label: "Review cancellation", href };
  }
  if (status === EcommerceOrderStatus.COD_PENDING_ACCEPTANCE) {
    return { key: "ACCEPT_COD", label: "Accept COD order", href };
  }
  if (status === EcommerceOrderStatus.PAID || status === EcommerceOrderStatus.PROCESSING) {
    if (mode === "DELIVERY") {
      return { key: "SHIP", label: "Ship order", href };
    }
    return { key: "READY_PICKUP", label: "Mark ready for pickup", href };
  }
  if (status === EcommerceOrderStatus.SHIPPED) {
    return { key: "DELIVER", label: "Confirm delivery", href };
  }
  if (status === EcommerceOrderStatus.READY_FOR_PICKUP) {
    return { key: "COLLECT", label: "Confirm collection", href };
  }
  if (status === EcommerceOrderStatus.REFUND_PENDING) {
    return { key: "TRACK_REFUND", label: "Track refund", href };
  }

  const displayStatusLabel = plainLanguageEcommerceOrderStatus(status);
  return {
    key: "OPEN",
    label: displayStatusLabel ? `View — ${displayStatusLabel}` : "Open order",
    href,
  };
}
