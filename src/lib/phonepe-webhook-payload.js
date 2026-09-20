import { classifyPhonePeCallback } from "./phonepe-callback-classification.js";
import { PhonePeCallbackClass } from "./phonepe-callback-classification.js";
import {
  isPhonePeCheckoutCompleted,
  isPhonePeCheckoutFailed,
  isPhonePeRefundCallback,
  isPhonePeTransactionAttemptFailed,
  phonePeCallbackReference,
  phonePeCallbackTransactionId,
} from "../integrations/phonepe.provider.js";

/** Normalize PhonePe SDK webhook callbacks `{ type, payload }`. */
export function normalizePhonePeWebhookEvent(eventPayload = {}) {
  if (eventPayload?.type !== undefined && eventPayload?.payload) {
    const classification = classifyPhonePeCallback(eventPayload.type);
    return {
      format: "sdk",
      type: eventPayload.type,
      payload: eventPayload.payload,
      reference: phonePeCallbackReference(eventPayload.payload),
      transactionId: phonePeCallbackTransactionId(eventPayload.payload),
      amount: eventPayload.payload.amount,
      classification,
      completed: isPhonePeCheckoutCompleted(eventPayload.type),
      failed: isPhonePeCheckoutFailed(eventPayload.type),
      attemptFailed: isPhonePeTransactionAttemptFailed(eventPayload.type),
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
    classification: PhonePeCallbackClass.UNKNOWN,
    completed: false,
    failed: false,
    attemptFailed: false,
    refund: false,
  };
}
