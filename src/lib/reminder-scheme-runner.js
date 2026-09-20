import { env } from "../config/env.js";
import { redisReady } from "../config/redis.js";
import { incrementOpsMetric, OpsMetric } from "./ops-metrics.js";
import { refreshReminderSchedulerLease } from "./reminder-scheduler-lease.js";
import {
  clearReminderStreamCursor,
  readReminderStreamCursor,
  writeReminderStreamCursor,
} from "./reminder-stream-cursor.js";

export function schemeBatchSize() {
  return env.REMINDER_SCHEME_BATCH_SIZE ?? 100;
}

export function maxSchemeBatchesPerTenantPerRun() {
  return env.REMINDER_MAX_SCHEME_BATCHES_PER_TENANT_PER_RUN ?? 5;
}

export function emptyTenantReminderStats() {
  return {
    queued: 0,
    schemesVisited: 0,
    skipped: 0,
    batchesProcessed: 0,
    hasMore: false,
    leaseLost: false,
    continuationScheduled: 0,
  };
}

export function mergeTenantReminderStats(into, part) {
  into.queued += part.queued ?? 0;
  into.schemesVisited += part.schemesVisited ?? 0;
  into.skipped += part.skipped ?? 0;
  into.batchesProcessed += part.batchesProcessed ?? 0;
  into.hasMore = into.hasMore || Boolean(part.hasMore);
  into.leaseLost = into.leaseLost || Boolean(part.leaseLost);
  into.continuationScheduled += part.continuationScheduled ?? 0;
  return into;
}

/**
 * Bounded keyset pagination with persisted cursor and lease checks.
 */
export async function runBoundedSchemeStream({
  stream,
  tenantId,
  today,
  windowKey,
  leaseToken,
  budget,
  fetchBatch,
  processBatch,
}) {
  const stats = emptyTenantReminderStats();
  const cursorKey = { tenantId, dayYmd: today, windowKey, stream };
  let cursor = (await readReminderStreamCursor(cursorKey)) ?? null;
  const maxBatches = maxSchemeBatchesPerTenantPerRun();

  for (let batchIdx = 0; batchIdx < maxBatches; batchIdx += 1) {
    if (budget.schemesLeft <= 0) {
      stats.hasMore = true;
      if (cursor) await writeReminderStreamCursor(cursorKey, cursor);
      stats.continuationScheduled = 1;
      incrementOpsMetric(OpsMetric.REMINDER_CONTINUATION_SCHEDULED);
      break;
    }
    const limit = Math.min(schemeBatchSize(), budget.schemesLeft);
    const schemes = await fetchBatch(cursor, limit);
    if (!schemes.length) {
      await clearReminderStreamCursor(cursorKey);
      break;
    }

    stats.batchesProcessed += 1;
    stats.schemesVisited += schemes.length;
    budget.schemesLeft -= schemes.length;

    const batchResult = await processBatch(schemes);
    stats.queued += batchResult.queued ?? 0;
    stats.skipped += batchResult.skipped ?? 0;

    cursor = schemes[schemes.length - 1]._id;
    const renewed = await refreshReminderSchedulerLease({
      tenantId,
      today,
      windowKey,
      token: leaseToken,
    });
    if (redisReady() && !renewed) {
      incrementOpsMetric(OpsMetric.REMINDER_LEASE_LOST);
      stats.leaseLost = true;
      stats.hasMore = true;
      await writeReminderStreamCursor(cursorKey, cursor);
      stats.continuationScheduled = 1;
      incrementOpsMetric(OpsMetric.REMINDER_CONTINUATION_SCHEDULED);
      break;
    }

    if (schemes.length < limit) {
      await clearReminderStreamCursor(cursorKey);
      break;
    }
    stats.hasMore = true;
  }

  if (stats.hasMore && !stats.leaseLost && stats.batchesProcessed >= maxBatches) {
    await writeReminderStreamCursor(cursorKey, cursor);
    if (!stats.continuationScheduled) {
      stats.continuationScheduled = 1;
      incrementOpsMetric(OpsMetric.REMINDER_CONTINUATION_SCHEDULED);
    }
  }

  if (stats.queued) incrementOpsMetric(OpsMetric.REMINDER_MESSAGES_QUEUED, stats.queued);
  incrementOpsMetric(OpsMetric.SCHEDULER_BATCH_PROCESSED, stats.schemesVisited);
  if (stats.skipped) incrementOpsMetric(OpsMetric.SCHEDULER_BATCH_SKIPPED, stats.skipped);

  return stats;
}
