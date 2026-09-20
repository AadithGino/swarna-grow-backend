import {
  callbackTypeKey,
  isPhonePeCheckoutCompleted,
  isPhonePeRefundCallback,
} from "../integrations/phonepe.provider.js";

export const PhonePeCallbackClass = Object.freeze({
  ORDER_COMPLETED: "ORDER_COMPLETED",
  ORDER_TERMINAL_FAILED: "ORDER_TERMINAL_FAILED",
  TRANSACTION_ATTEMPT_FAILED: "TRANSACTION_ATTEMPT_FAILED",
  REFUND: "REFUND",
  UNKNOWN: "UNKNOWN",
});

export function classifyPhonePeCallback(type) {
  const key = callbackTypeKey(type);
  if (isPhonePeCheckoutCompleted(type)) return PhonePeCallbackClass.ORDER_COMPLETED;
  if (isPhonePeRefundCallback(type)) return PhonePeCallbackClass.REFUND;
  if (
    key === "CHECKOUT_ORDER_FAILED"
    || key === "PG_ORDER_FAILED"
  ) {
    return PhonePeCallbackClass.ORDER_TERMINAL_FAILED;
  }
  if (
    key === "CHECKOUT_TRANSACTION_ATTEMPT_FAILED"
    || key === "PG_TRANSACTION_ATTEMPT_FAILED"
  ) {
    return PhonePeCallbackClass.TRANSACTION_ATTEMPT_FAILED;
  }
  return PhonePeCallbackClass.UNKNOWN;
}

/** Terminal order failure only — not a retryable attempt failure. */
export function isPhonePeTerminalOrderFailed(type) {
  return classifyPhonePeCallback(type) === PhonePeCallbackClass.ORDER_TERMINAL_FAILED;
}

export function isPhonePeTransactionAttemptFailed(type) {
  return classifyPhonePeCallback(type) === PhonePeCallbackClass.TRANSACTION_ATTEMPT_FAILED;
}
