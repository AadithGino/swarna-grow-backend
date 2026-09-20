import { JobStatus } from "../constants/enums.js";
import { env } from "../config/env.js";
import { incrementOpsMetric, OpsMetric } from "./ops-metrics.js";
import { Message, OutboxEvent } from "../models/index.js";

export const LEGACY_ORPHAN_ERROR = "LEGACY_MESSAGE_SEND_ORPHAN";

export function legacyMessageSendBatchLimit() {
  return env.LEGACY_MESSAGE_SEND_OUTBOX_BATCH_SIZE ?? 200;
}

/**
 * Terminalize legacy message.send outbox rows that have no Message (idempotent CAS).
 * Does not delete rows — sets COMPLETED with audit metadata in error field.
 */
export async function reconcileLegacyMessageSendOutboxBatch({ dryRun = false } = {}) {
  const limit = legacyMessageSendBatchLimit();
  const rows = await OutboxEvent.find({
    status: JobStatus.QUEUED,
    topic: "message.send",
  })
    .sort({ _id: 1 })
    .limit(limit)
    .select("_id tenantId key payload")
    .lean();

  let processed = 0;
  let completed = 0;
  let skippedHasMessage = 0;
  let failed = 0;

  for (const row of rows) {
    processed += 1;
    const messageId = row.payload?.messageId ?? row.key;
    if (!messageId) {
      failed += 1;
      if (!dryRun) {
        await OutboxEvent.updateOne(
          { _id: row._id, status: JobStatus.QUEUED, topic: "message.send" },
          {
            $set: {
              status: JobStatus.COMPLETED,
              processedAt: new Date(),
              error: `${LEGACY_ORPHAN_ERROR}:MISSING_MESSAGE_ID`,
            },
          },
        );
      }
      continue;
    }
    const exists = await Message.exists({ _id: messageId, tenantId: row.tenantId });
    if (exists) {
      skippedHasMessage += 1;
      if (!dryRun) {
        const updated = await OutboxEvent.updateOne(
          { _id: row._id, status: JobStatus.QUEUED, topic: "message.send" },
          {
            $set: {
              status: JobStatus.COMPLETED,
              processedAt: new Date(),
              error: null,
            },
          },
        );
        if (updated.modifiedCount) completed += 1;
      }
      continue;
    }
    if (dryRun) {
      completed += 1;
      continue;
    }
    const updated = await OutboxEvent.updateOne(
      { _id: row._id, status: JobStatus.QUEUED, topic: "message.send" },
      {
        $set: {
          status: JobStatus.COMPLETED,
          processedAt: new Date(),
          error: LEGACY_ORPHAN_ERROR,
        },
      },
    );
    if (updated.modifiedCount) {
      completed += 1;
      incrementOpsMetric(OpsMetric.LEGACY_OUTBOX_ORPHAN_COMPLETED, 1);
    } else {
      failed += 1;
    }
  }

  return { processed, completed, skippedHasMessage, failed, dryRun, limit };
}

/** Keyset continuation for restartable migration scripts. */
export async function reconcileLegacyMessageSendOutboxKeyset({
  dryRun = false,
  afterId = null,
  limit = legacyMessageSendBatchLimit(),
} = {}) {
  const query = {
    status: JobStatus.QUEUED,
    topic: "message.send",
    ...(afterId ? { _id: { $gt: afterId } } : {}),
  };
  const rows = await OutboxEvent.find(query)
    .sort({ _id: 1 })
    .limit(limit)
    .select("_id tenantId key payload")
    .lean();

  let processed = 0;
  let completed = 0;
  let skippedHasMessage = 0;
  let failed = 0;
  let lastId = afterId;

  for (const row of rows) {
    lastId = row._id;
    processed += 1;
    const messageId = row.payload?.messageId ?? row.key;
    if (!messageId) {
      failed += 1;
      if (!dryRun) {
        await OutboxEvent.updateOne(
          { _id: row._id, status: JobStatus.QUEUED },
          {
            $set: {
              status: JobStatus.COMPLETED,
              processedAt: new Date(),
              error: `${LEGACY_ORPHAN_ERROR}:MISSING_MESSAGE_ID`,
            },
          },
        );
      }
      continue;
    }
    const exists = await Message.exists({ _id: messageId, tenantId: row.tenantId });
    if (exists) {
      skippedHasMessage += 1;
      if (!dryRun) {
        const r = await OutboxEvent.updateOne(
          { _id: row._id, status: JobStatus.QUEUED },
          { $set: { status: JobStatus.COMPLETED, processedAt: new Date(), error: null } },
        );
        if (r.modifiedCount) completed += 1;
      } else {
        completed += 1;
      }
      continue;
    }
    if (dryRun) {
      completed += 1;
      continue;
    }
    const r = await OutboxEvent.updateOne(
      { _id: row._id, status: JobStatus.QUEUED },
      {
        $set: {
          status: JobStatus.COMPLETED,
          processedAt: new Date(),
          error: LEGACY_ORPHAN_ERROR,
        },
      },
    );
    if (r.modifiedCount) completed += 1;
    else failed += 1;
  }

  return {
    processed,
    completed,
    skippedHasMessage,
    failed,
    dryRun,
    limit,
    lastId,
    hasMore: rows.length === limit,
  };
}
