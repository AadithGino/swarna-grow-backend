import { errors } from "./app-error.js";
import { hashIdempotencyBody } from "../services/idempotency.service.js";

export function hashDigitalMetalsOrderBody(body) {
  return hashIdempotencyBody(body);
}

function orderBodyBindingMatches(order, body, bodyHash) {
  if (order.creationBodyHash) {
    return order.creationBodyHash === bodyHash;
  }
  const quoteId = String(body?.quoteId ?? "").trim();
  if (!quoteId || String(order.quoteId) !== quoteId) {
    return false;
  }
  const termsVersion = String(body?.termsVersionAccepted ?? "");
  const termsHash = String(body?.termsContentHashAccepted ?? "");
  if (order.termsVersion != null && String(order.termsVersion) !== termsVersion) {
    return false;
  }
  if (order.termsContentHash != null && String(order.termsContentHash) !== termsHash) {
    return false;
  }
  return true;
}

/**
 * Validates tenant-wide idempotency replay for customer-bound DM orders.
 * Wrong customer → not found (no cross-customer leakage).
 */
export function resolveCustomerBoundIdempotencyReplay({ order, customerId, body, bodyHash }) {
  if (!order) return null;
  if (String(order.customerId) !== String(customerId)) {
    throw errors.notFound("Order");
  }
  if (!orderBodyBindingMatches(order, body, bodyHash)) {
    throw errors.conflict(
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was already used with a different request.",
    );
  }
  return order;
}
