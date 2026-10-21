import { MessageStatus } from "../constants/enums.js";
import { createId } from "./ids.js";
import { dispatchPriorityForMessageType } from "./message-dispatch-priority.js";
import { Message } from "../models/index.js";

export function isDuplicateKeyError(err) {
  return err?.code === 11000 || (err?.name === "MongoServerError" && err?.code === 11000);
}

/**
 * Atomically claim logical inbox identity via unique reminderDedupeKey + templateParams.inboxEventKey.
 * Multi-device push delivery still fans out from the single Message row downstream.
 */
export async function queueDigitalMetalInboxPushMessage({
  tenantId,
  branchId,
  customerId,
  type,
  inboxEventKey,
  templateParams,
  session,
}) {
  const dedupeFilter = {
    tenantId,
    $or: [
      { reminderDedupeKey: inboxEventKey },
      { "templateParams.inboxEventKey": inboxEventKey },
    ],
  };
  let existingQuery = Message.findOne(dedupeFilter).select("_id").lean();
  if (session) existingQuery = existingQuery.session(session);
  const existing = await existingQuery;
  if (existing) {
    return { outcome: "ALREADY_NOTIFIED", messageId: existing._id };
  }

  const messageId = createId("message");
  try {
    const row = (
      await Message.create(
        [
          {
            _id: messageId,
            tenantId,
            branchId: branchId ?? null,
            customerId,
            schemeId: null,
            type,
            status: MessageStatus.QUEUED,
            channel: "PUSH",
            dispatchPriority: dispatchPriorityForMessageType(type),
            templateKey: type,
            reminderDedupeKey: inboxEventKey,
            templateParams: {
              ...templateParams,
              inboxEventKey,
            },
          },
        ],
        session ? { session } : undefined,
      )
    )[0];
    return { outcome: "QUEUED", messageId: row._id, row: row.toObject() };
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      if (session) {
        // Write error aborts the Mongo transaction; surface to caller outside withTransaction.
        throw err;
      }
      const raced = await Message.findOne(dedupeFilter).select("_id").lean();
      if (raced) {
        return { outcome: "ALREADY_NOTIFIED", messageId: raced._id };
      }
    }
    throw err;
  }
}
