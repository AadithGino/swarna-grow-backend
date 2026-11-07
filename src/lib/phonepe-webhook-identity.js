import crypto from "node:crypto";
import {
  callbackTypeKey,
  isPhonePeRefundCallback,
  phonePeCallbackReference,
  phonePeCallbackTransactionId,
} from "../integrations/phonepe.provider.js";

/** Audit-only digest of raw bytes (not used for event identity). */
export function phonePeWebhookRawBodyAuditDigest(rawBody) {
  if (!rawBody?.length) return null;
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function stablePayloadDigest(payload = {}) {
  const canonical = JSON.stringify(payload ?? {});
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Provider refund correlation (merchantRefundId / refundId), not checkout merchant order id. */
export function phonePeRefundMerchantIdentity(payload = {}) {
  const candidate =
    payload.merchantRefundId
    ?? payload.refundId
    ?? payload.providerRefundId
    ?? payload.refundDetails?.[0]?.refundId
    ?? payload.refundDetails?.[0]?.merchantRefundId;
  if (candidate == null || candidate === "") return null;
  return String(candidate);
}

/**
 * PhonePe may supply eventId/callbackId on some callbacks. We do not treat them as globally
 * unique across event types, lifecycle states, or partial refunds (no verified uniqueness contract).
 */
export function phonePeDocumentedCallbackCorrelationId(payload = {}) {
  const candidate = payload.eventId ?? payload.callbackId;
  if (candidate == null || candidate === "") return null;
  return String(candidate);
}

/** Deterministic identity from normalized callback fields (whitespace/key order insensitive). */
export function canonicalPhonePeSemanticEventId({ tenantId, type, payload = {} }) {
  const reference = phonePeCallbackReference(payload) ?? payload.orderId ?? "unknown-order";
  const transactionId = phonePeCallbackTransactionId(payload) ?? "no-txn";
  const typeKey = callbackTypeKey(type) ?? "UNKNOWN";
  const state =
    payload.state
    ?? payload.paymentDetails?.[0]?.state
    ?? payload.status
    ?? "unknown-state";
  const refundIdentity = isPhonePeRefundCallback(type)
    ? (phonePeRefundMerchantIdentity(payload) ?? "no-refund-id")
    : null;
  const refundSegment = refundIdentity ? `:ref:${refundIdentity}` : "";
  return `pe:${tenantId}:${typeKey}:${reference}:${transactionId}:${state}${refundSegment}`;
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
  rawBody: _rawBody = null,
}) {
  return canonicalPhonePeSemanticEventId({ tenantId, type, payload });
}

export function phonePeWebhookEventIdentityCandidates({
  tenantId,
  type,
  payload = {},
  rawBody = null,
}) {
  const primary = buildPhonePeWebhookEventId({ tenantId, type, payload, rawBody });
  const legacy = buildPhonePeLegacyWebhookEventId({ tenantId, payload });
  const documented = phonePeDocumentedCallbackCorrelationId(payload);
  const documentedAlias = documented ? `pe:${tenantId}:doc:${documented}` : null;
  const aliases = [
    ...(legacy && legacy !== primary ? [legacy] : []),
    ...(documentedAlias && documentedAlias !== primary ? [documentedAlias] : []),
  ];
  return {
    primary,
    aliases,
    semanticKey: canonicalPhonePeSemanticEventId({ tenantId, type, payload }),
    bodyDigest: phonePeWebhookRawBodyAuditDigest(rawBody) ?? stablePayloadDigest(payload).slice(0, 64),
  };
}

export function phonePeSemanticEventIdFromStoredPayload(tenantId, storedPayload) {
  if (!storedPayload || typeof storedPayload !== "object") return null;
  const inner = storedPayload.payload && typeof storedPayload.payload === "object"
    ? storedPayload.payload
    : storedPayload;
  const type = storedPayload.type ?? inner.type;
  if (!type) return null;
  return canonicalPhonePeSemanticEventId({ tenantId, type, payload: inner });
}

export function phonePeWebhookSemanticKeysMatch(storedProviderEventId, semanticKey, storedPayload, tenantId) {
  if (!semanticKey) return false;
  if (storedProviderEventId === semanticKey) return true;
  const fromPayload = phonePeSemanticEventIdFromStoredPayload(tenantId, storedPayload);
  if (fromPayload && fromPayload === semanticKey) return true;
  return false;
}
