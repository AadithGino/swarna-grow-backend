import crypto from "node:crypto";

/** Deterministic message id: one push per broadcast customer. */
export function deterministicBroadcastMessageId(tenantId, broadcastId, customerId) {
  const digest = crypto
    .createHash("sha256")
    .update(`${tenantId}\0${broadcastId}\0${customerId}\0PUSH`, "utf8")
    .digest("hex");
  return `msg_${digest.slice(0, 26)}`;
}

export function broadcastIdempotencyKey(tenantId, broadcastId, customerId) {
  return `${tenantId}:${broadcastId}:${customerId}:PUSH`;
}
