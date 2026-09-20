import { MessageStatus } from "../constants/enums.js";
import { dispatchPriorityForMessageType } from "../lib/message-dispatch-priority.js";
import {
  buildReminderDedupeKey,
  deterministicReminderMessageId,
} from "../lib/reminder-dedupe.js";
import { Message } from "../models/index.js";

/**
 * Atomically claim a reminder slot for one channel. Returns message id when inserted.
 */
export async function claimReminderMessage({
  tenantId,
  branchId,
  customerId,
  schemeId,
  type,
  channel,
  offsetKey,
  reminderDate,
  installmentNumber,
  templateKey,
  templateParams,
}) {
  const dedupeKey = buildReminderDedupeKey({
    tenantId,
    schemeId,
    messageType: type,
    channel,
    offsetKey,
    reminderDate,
    installmentNumber,
  });
  const messageId = deterministicReminderMessageId(dedupeKey);
  const insertResult = await Message.updateOne(
    { reminderDedupeKey: dedupeKey },
    {
      $setOnInsert: {
        _id: messageId,
        tenantId,
        branchId,
        customerId,
        schemeId,
        type,
        channel,
        status: MessageStatus.QUEUED,
        templateKey: templateKey ?? type,
        templateParams: {
          ...templateParams,
          reminderDate,
          offsetKey,
          ...(installmentNumber != null ? { installmentNumber } : {}),
        },
        reminderDedupeKey: dedupeKey,
        dispatchPriority: dispatchPriorityForMessageType(type),
      },
    },
    { upsert: true },
  );
  if (!insertResult.upsertedCount) return null;
  return messageId;
}

export async function attachPaymentLinkToMessage(messageId, paymentLinkToken) {
  if (!messageId || !paymentLinkToken) return;
  await Message.updateOne(
    { _id: messageId },
    { $set: { "templateParams.paymentLinkToken": paymentLinkToken } },
  );
}
