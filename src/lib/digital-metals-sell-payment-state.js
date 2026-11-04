import { OPEN_PAYOUT_IN_FLIGHT_STATUSES } from "./digital-metals-open-work-statuses.js";

/** Plain-language payment progress on an accepted sell (stored enums unchanged). */
export const SELL_PAYMENT_DISPLAY = Object.freeze({
  AWAITING_CONFIRMATION: "Confirm sale",
  AWAITING_ACCEPTANCE: "Previous request needs review",
  UNPAID: "Payment pending",
  PARTIALLY_PAID: "Partially paid",
  PAID: "Paid",
  PAYMENT_BEING_CHECKED: "Payment being checked",
});

export function deriveSellPaymentDisplayState({ sellStatus, payable, payouts = [] }) {
  if (sellStatus === "RESERVED") {
    return { key: "AWAITING_CONFIRMATION", label: SELL_PAYMENT_DISPLAY.AWAITING_CONFIRMATION };
  }
  if (sellStatus === "PENDING_APPROVAL") {
    return { key: "AWAITING_ACCEPTANCE", label: SELL_PAYMENT_DISPLAY.AWAITING_ACCEPTANCE };
  }
  if (!payable) {
    if (sellStatus === "PAYABLE_OPEN") {
      return { key: "UNPAID", label: SELL_PAYMENT_DISPLAY.UNPAID };
    }
    return null;
  }
  const inFlight = payouts.some((p) => OPEN_PAYOUT_IN_FLIGHT_STATUSES.includes(p.status));
  if (inFlight) {
    return { key: "PAYMENT_BEING_CHECKED", label: SELL_PAYMENT_DISPLAY.PAYMENT_BEING_CHECKED };
  }
  const outstanding = Number(payable.outstandingPaise ?? 0);
  const amount = Number(payable.amountPaise ?? 0);
  if (payable.status === "SETTLED" || outstanding <= 0) {
    return { key: "PAID", label: SELL_PAYMENT_DISPLAY.PAID };
  }
  if (outstanding < amount) {
    return { key: "PARTIALLY_PAID", label: SELL_PAYMENT_DISPLAY.PARTIALLY_PAID };
  }
  return { key: "UNPAID", label: SELL_PAYMENT_DISPLAY.UNPAID };
}

export function buildPermittedSellOrderActions(order, paymentState) {
  const actions = [];
  if (!order) return actions;
  if (order.status === "PENDING_APPROVAL") actions.push("ACCEPT_SALE");
  if (order.status === "PAYABLE_OPEN" && paymentState?.key !== "PAYMENT_BEING_CHECKED") {
    if (paymentState?.key === "UNPAID" || paymentState?.key === "PARTIALLY_PAID") {
      actions.push("RECORD_PAYMENT");
    }
  }
  if (paymentState?.key === "PAYMENT_BEING_CHECKED") actions.push("REVIEW_PAYOUT");
  return actions;
}
