import crypto from "node:crypto";
import { callbackTypeKey } from "../integrations/phonepe.provider.js";
import {
  phonePeCallbackReference,
  phonePeCallbackTransactionId,
} from "../integrations/phonepe.provider.js";

function stablePayloadDigest(payload = {}, rawBody) {
  if (rawBody?.length) {
    return crypto.createHash("sha256").update(rawBody).digest("hex");
  }
  const canonical = JSON.stringify(payload ?? {});
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Immutable PhonePe webhook identity for { tenantId, provider, providerEventId } uniqueness.
 */
export function buildPhonePeWebhookEventId({
  tenantId,
  type,
  payload = {},
  rawBody = null,
}) {
  const immutableId =
    payload.eventId
    ?? payload.callbackId
    ?? payload.id
    ?? payload.paymentDetails?.[0]?.transactionId;
  if (immutableId) {
    return `pe:${tenantId}:${String(immutableId)}`;
  }

  const reference = phonePeCallbackReference(payload) ?? payload.orderId ?? "unknown-order";
  const transactionId = phonePeCallbackTransactionId(payload) ?? "no-txn";
  const typeKey = callbackTypeKey(type) ?? "UNKNOWN";
  const state =
    payload.state
    ?? payload.paymentDetails?.[0]?.state
    ?? payload.status
    ?? "unknown-state";
  const digest = stablePayloadDigest(payload, rawBody).slice(0, 32);
  return `pe:${tenantId}:${typeKey}:${reference}:${transactionId}:${state}:${digest}`;
}
