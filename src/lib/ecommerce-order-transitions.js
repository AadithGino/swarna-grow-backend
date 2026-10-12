import { EcommerceOrderStatus } from "../constants/enums.js";
import { AppError } from "./app-error.js";

/** Allowed order status transitions by actor class (V1). */
export const ECOMMERCE_ORDER_TRANSITIONS = Object.freeze({
  SYSTEM: Object.freeze({
    [EcommerceOrderStatus.PENDING_PAYMENT]: [
      EcommerceOrderStatus.PAID,
      EcommerceOrderStatus.PAYMENT_FAILED,
      EcommerceOrderStatus.PAYMENT_EXPIRED,
      EcommerceOrderStatus.CANCELLED,
    ],
    [EcommerceOrderStatus.PAID]: [EcommerceOrderStatus.PROCESSING, EcommerceOrderStatus.REFUND_PENDING],
    [EcommerceOrderStatus.PROCESSING]: [
      EcommerceOrderStatus.READY_FOR_PICKUP,
      EcommerceOrderStatus.SHIPPED,
      EcommerceOrderStatus.REFUND_PENDING,
    ],
    [EcommerceOrderStatus.READY_FOR_PICKUP]: [
      EcommerceOrderStatus.DELIVERED,
      EcommerceOrderStatus.REFUND_PENDING,
    ],
    [EcommerceOrderStatus.SHIPPED]: [
      EcommerceOrderStatus.DELIVERED,
      EcommerceOrderStatus.REFUND_PENDING,
    ],
    [EcommerceOrderStatus.REFUND_PENDING]: [EcommerceOrderStatus.REFUNDED],
  }),
  STAFF: Object.freeze({
    [EcommerceOrderStatus.PAID]: [EcommerceOrderStatus.PROCESSING],
    [EcommerceOrderStatus.PROCESSING]: [
      EcommerceOrderStatus.READY_FOR_PICKUP,
      EcommerceOrderStatus.SHIPPED,
    ],
    [EcommerceOrderStatus.READY_FOR_PICKUP]: [EcommerceOrderStatus.DELIVERED],
    [EcommerceOrderStatus.SHIPPED]: [EcommerceOrderStatus.DELIVERED],
  }),
  CUSTOMER: Object.freeze({
    [EcommerceOrderStatus.PENDING_PAYMENT]: [EcommerceOrderStatus.CANCELLED],
    [EcommerceOrderStatus.COD_PENDING_ACCEPTANCE]: [EcommerceOrderStatus.CANCELLED],
  }),
});

export function assertEcommerceOrderTransition(actorClass, fromStatus, toStatus) {
  const map = ECOMMERCE_ORDER_TRANSITIONS[actorClass] ?? {};
  const allowed = map[fromStatus] ?? [];
  if (allowed.includes(toStatus)) return;
  throw new AppError(
    "INVALID_STATE_TRANSITION",
    `Cannot move order from ${fromStatus} to ${toStatus}.`,
    409,
    { fromStatus, toStatus, actorClass },
  );
}
