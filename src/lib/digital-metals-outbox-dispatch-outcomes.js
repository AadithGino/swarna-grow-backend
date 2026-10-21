/** Explicit digital-metal outbox dispatch disposition (Phase 10). */

/** Successful processing — customer was notified or non-notice work finished. */
export const DISPATCH_COMPLETED = new Set([
  "QUEUED",
  "READY",
  "ALREADY_READY",
  "NOT_A_NOTICE_TOPIC",
]);

export const DISPATCH_SKIPPED = new Set([
  "ALREADY_NOTIFIED",
  "NO_DELIVERY_CHANNEL",
  "SKIPPED_SUPERSEDED",
]);

export const DISPATCH_RETRYABLE = new Set([
  "QUEUE_FAILED",
  "DOCUMENT_NOT_READY",
  "ORDER_NOT_CREDITED",
  "DELAYED_TRANSITION",
  "RETRY_SCHEDULED",
  "NOT_CLAIMABLE",
  "FINALIZE_RACE",
  "ERROR",
]);

export const DISPATCH_TERMINAL = new Set([
  "INVALID_PAYLOAD",
  "UNKNOWN_TOPIC",
  "CUSTOMER_NOT_FOUND",
  "ORDER_NOT_FOUND",
  "PAYOUT_NOT_FOUND",
  "CUSTOMER_UNKNOWN",
  "FAILED",
]);

export function classifyDigitalMetalOutboxDispatchOutcome(result) {
  const outcome = String(result?.outcome ?? "UNKNOWN");
  if (DISPATCH_SKIPPED.has(outcome)) {
    return { disposition: "SKIPPED", outcome, retryable: false, terminal: false, skipReason: outcome };
  }
  if (DISPATCH_COMPLETED.has(outcome)) {
    return { disposition: "COMPLETED", outcome, retryable: false, terminal: false };
  }
  if (DISPATCH_RETRYABLE.has(outcome)) {
    return { disposition: "RETRYABLE", outcome, retryable: true, terminal: false };
  }
  if (DISPATCH_TERMINAL.has(outcome)) {
    return { disposition: "TERMINAL", outcome, retryable: false, terminal: true };
  }
  if (outcome.endsWith("_STATE_MISMATCH")) {
    return { disposition: "SKIPPED", outcome, retryable: false, terminal: false, superseded: true };
  }
  if (outcome.endsWith("_NOT_FAILED") || outcome === "SELL_NOT_EXECUTED" || outcome === "PAYMENT_ATTEMPT_MISMATCH") {
    return { disposition: "SKIPPED", outcome, retryable: false, terminal: false };
  }
  return { disposition: "RETRYABLE", outcome, retryable: true, terminal: false };
}
