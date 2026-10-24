/** Customer app: orders still in progress (open-summary counts). */
export const CUSTOMER_OPEN_BUY_ORDER_STATUSES = Object.freeze([
  "QUOTE_ACCEPTED",
  "PAYMENT_PENDING",
  "PAYMENT_VERIFIED",
  "PAYMENT_FAILED",
]);

export const CUSTOMER_OPEN_SELL_ORDER_STATUSES = Object.freeze([
  "RESERVED",
  "PENDING_APPROVAL",
  "PAYABLE_OPEN",
]);

export const CUSTOMER_OPEN_REDEMPTION_ORDER_STATUSES = Object.freeze([
  "QUOTE_ACCEPTED",
  "CHARGE_PAYMENT_PENDING",
  "CHARGE_PAYMENT_FAILED",
  "CHARGE_PAID",
  "FULFILMENT_ACCEPTED",
  "PACKING",
  "DISPATCHED",
  "PICKUP_READY",
  "INVESTIGATION",
]);

/** Admin fulfilment queue default filter. */
export const ADMIN_FULFILMENT_QUEUE_STATUSES = Object.freeze([
  "CHARGE_PAID",
  "FULFILMENT_ACCEPTED",
  "PACKING",
  "DISPATCHED",
  "PICKUP_READY",
  "INVESTIGATION",
]);

/** Outstanding sell settlement liability. */
export const OPEN_PAYABLE_STATUSES = Object.freeze(["OPEN"]);

/** Payout attempts that block new instructions or count toward payable cap. */
export const OPEN_PAYOUT_IN_FLIGHT_STATUSES = Object.freeze([
  "PENDING_APPROVAL",
  "APPROVED",
  "SUBMITTED",
  "UNKNOWN",
]);

/** Redemption charge refund cases awaiting staff or provider resolution. */
export const OPEN_REDEMPTION_CHARGE_REFUND_STATUSES = Object.freeze([
  "ASSIGNED",
  "REFUND_INITIATED",
  "FAILED",
]);
