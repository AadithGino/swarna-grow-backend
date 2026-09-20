import crypto from "node:crypto";

export function buildReminderDedupeKey({
  tenantId,
  schemeId,
  messageType,
  channel,
  offsetKey,
  reminderDate,
  installmentNumber = null,
}) {
  const installmentPart = installmentNumber == null ? "-" : String(installmentNumber);
  return [
    tenantId,
    schemeId,
    messageType,
    channel,
    offsetKey,
    reminderDate,
    installmentPart,
  ].join(":");
}

export function deterministicReminderMessageId(dedupeKey) {
  const digest = crypto.createHash("sha256").update(dedupeKey, "utf8").digest("hex");
  return `msg_${digest.slice(0, 26)}`;
}
