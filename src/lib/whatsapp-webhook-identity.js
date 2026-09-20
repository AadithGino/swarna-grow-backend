import { sha256 } from "./crypto.js";

export function buildWhatsAppWebhookEventId({ tenantId, payload = {} }) {
  const status = payload.entry?.[0]?.changes?.[0]?.value?.statuses?.[0];
  if (status?.id) return `wa:${tenantId}:${status.id}`;
  const entryId = payload.entry?.[0]?.id;
  if (entryId) return `wa:${tenantId}:${entryId}`;
  const digest = sha256(JSON.stringify(payload)).slice(0, 32);
  return `wa:${tenantId}:digest:${digest}`;
}
