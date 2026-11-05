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

function documentedUniqueProviderEventId(payload = {}) {
  const candidate =
    payload.eventId
    ?? payload.callbackId
    ?? payload.id;
  if (candidate == null || candidate === "") return null;
  return String(candidate);
}

function canonicalSemanticEventId({ tenantId, type, payload = {}, rawBody = null }) {
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

/**
 * Pre-remediation identity: transactionId alone was treated as unique (AUD-06).
 * Kept for dedupe compatibility with stored webhook rows and queued jobs.
 */
export function buildPhonePeLegacyWebhookEventId({ tenantId, payload = {} }) {
  const txn = payload.paymentDetails?.[0]?.transactionId;
  if (!txn) return null;
  return `pe:${tenantId}:${String(txn)}`;
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
  const documented = documentedUniqueProviderEventId(payload);
  if (documented) {
    return `pe:${tenantId}:${documented}`;
  }
  return canonicalSemanticEventId({ tenantId, type, payload, rawBody });
}

export function phonePeWebhookEventIdentityCandidates({
  tenantId,
  type,
  payload = {},
  rawBody = null,
}) {
  const primary = buildPhonePeWebhookEventId({ tenantId, type, payload, rawBody });
  const legacy = buildPhonePeLegacyWebhookEventId({ tenantId, payload });
  const aliases = legacy && legacy !== primary ? [legacy] : [];
  return { primary, aliases };
}
