import {
  isPhonePeCheckoutCompleted,
  isPhonePeCheckoutFailed,
  isPhonePeRefundCallback,
  phonePeCallbackReference,
  phonePeCallbackTransactionId,
} from "../integrations/phonepe.provider.js";

/** Normalize PhonePe SDK webhook callbacks `{ type, payload }`. */
export function normalizePhonePeWebhookEvent(eventPayload = {}) {
  if (eventPayload?.type !== undefined && eventPayload?.payload) {
    return {
      format: "sdk",
      type: eventPayload.type,
      payload: eventPayload.payload,
      reference: phonePeCallbackReference(eventPayload.payload),
      transactionId: phonePeCallbackTransactionId(eventPayload.payload),
      amount: eventPayload.payload.amount,
      completed: isPhonePeCheckoutCompleted(eventPayload.type),
      failed: isPhonePeCheckoutFailed(eventPayload.type),
      refund: isPhonePeRefundCallback(eventPayload.type),
    };
  }

  return {
    format: "unknown",
    type: null,
    payload: eventPayload,
    reference: null,
    transactionId: null,
    amount: null,
    completed: false,
    failed: false,
    refund: false,
  };
}
