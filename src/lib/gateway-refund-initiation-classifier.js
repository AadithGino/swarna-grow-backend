import { AppError } from "./app-error.js";

/** @typedef {"DEFINITIVE_REJECT" | "AMBIGUOUS" | "TRANSIENT"} RefundInitiationFailureClass */

const DEFINITIVE_CODES = new Set([
  "PAYMENT_GATEWAY_NOT_CONFIGURED",
  "REFUND_AMOUNT_INVALID",
  "REFUND_NOT_GATEWAY",
  "VALIDATION_FAILED",
  "PHONEPE_REFUND_REJECTED",
]);

/**
 * Classify provider/initiation errors for reservation retention vs release.
 * Ambiguous network/timeouts must not release reservations (PhonePe may have accepted).
 */
export function classifyRefundInitiationError(error) {
  if (error instanceof AppError) {
    if (DEFINITIVE_CODES.has(error.code)) return "DEFINITIVE_REJECT";
    if (error.statusCode >= 400 && error.statusCode < 500 && error.code !== "DEPENDENCY_UNAVAILABLE") {
      return "DEFINITIVE_REJECT";
    }
    if (error.code === "DEPENDENCY_UNAVAILABLE") return "AMBIGUOUS";
  }
  const message = String(error?.message ?? "").toLowerCase();
  if (
    message.includes("timeout")
    || message.includes("timed out")
    || message.includes("econnreset")
    || message.includes("etimedout")
    || message.includes("network")
    || message.includes("socket")
    || message.includes("transient")
  ) {
    return "AMBIGUOUS";
  }
  if (String(error?.code ?? "").startsWith("E")) return "AMBIGUOUS";
  return "AMBIGUOUS";
}

export function isDefinitiveRefundInitiationFailure(error) {
  return classifyRefundInitiationError(error) === "DEFINITIVE_REJECT";
}
