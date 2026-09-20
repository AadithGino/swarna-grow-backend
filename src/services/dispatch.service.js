import { JobStatus } from "../constants/enums.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import {
  acknowledgeDispatch,
  claimDispatchLease,
  dispatchClaimEligibleFilter,
  messageDispatchStatusFilter,
  releaseDispatchLease,
} from "../lib/dispatch-lease.js";
import {
  readDispatchPauseAfterClaim,
  readDispatchPauseAfterQueue,
  readDispatchThrowOnQueueAdd,
} from "../lib/dispatch-test-hooks.js";
import { fetchFairDispatchCandidates } from "../lib/fair-message-dispatch.js";
import { incrementOpsMetric, OpsMetric } from "../lib/ops-metrics.js";
import { Message, OutboxEvent, WebhookEvent } from "../models/index.js";
import { getQueue } from "../queues/index.js";

function dispatchOwner() {
  return `dispatch:${process.pid}:${Date.now()}`;
}

async function enqueueWithDeterministicId(queue, { name, data, jobId, backoffDelay = 5000 }) {
  if (readDispatchThrowOnQueueAdd()) {
    throw new Error("DISPATCH_TEST_QUEUE_ADD_FAILURE");
  }
  try {
    await queue.add(name, data, {
      jobId,
      attempts: 5,
      backoff: { type: "exponential", delay: backoffDelay },
    });
    incrementOpsMetric(OpsMetric.DISPATCH_QUEUE_ADD, 1);
    return { added: true };
  } catch (error) {
    if (String(error?.message ?? "").includes("Job") && String(error?.message ?? "").includes("exists")) {
      incrementOpsMetric(OpsMetric.DISPATCH_QUEUE_DEDUPED, 1);
      return { added: false, deduped: true };
    }
    throw error;
  }
}

/**
 * Claim, enqueue, and acknowledge one row. Returns false when claim lost.
 */
async function dispatchOne({ model, extraFilter, row, queue, buildJob, owner }) {
  const claimed = await claimDispatchLease(model, extraFilter, row._id, owner);
  if (!claimed) return { ok: false, reason: "claim_lost" };
  incrementOpsMetric(OpsMetric.DISPATCH_CLAIM, 1);

  if (readDispatchPauseAfterClaim()) {
    return { ok: true, paused: "after_claim" };
  }

  const job = buildJob(row);
  try {
    await enqueueWithDeterministicId(queue, {
      ...job,
      backoffDelay: job.backoffDelay ?? 5000,
    });
  } catch (error) {
    await releaseDispatchLease(model, row._id, owner);
    throw error;
  }

  if (readDispatchPauseAfterQueue()) {
    return { ok: true, paused: "after_queue" };
  }

  const acked = await acknowledgeDispatch(model, row._id, owner);
  if (!acked) {
    logger.warn({ entityId: row._id }, "Dispatch ack lost after queue add — job id is deterministic");
  }
  return { ok: true, acked: Boolean(acked) };
}

async function dispatchMessages(messageQueue, owner) {
  if (!messageQueue) return;
  const globalCap = env.MESSAGE_DISPATCH_BATCH_SIZE ?? 250;
  const perTenant = env.MESSAGE_DISPATCH_TENANT_BATCH_SIZE ?? 50;
  const now = new Date();
  const baseFilter = {
    ...messageDispatchStatusFilter,
    ...dispatchClaimEligibleFilter(now),
  };
  const { batch } = await fetchFairDispatchCandidates(Message, baseFilter, {
    perTenant,
    global: globalCap,
    sort: { dispatchPriority: 1, createdAt: 1 },
    select: "_id type tenantId createdAt dispatchPriority",
  });
  if (!batch.length) return;

  const oldest = batch[0]?.createdAt;
  const lagMs = oldest ? Date.now() - new Date(oldest).getTime() : 0;
  logger.info(
    {
      batchSize: batch.length,
      tenantCount: new Set(batch.map((row) => row.tenantId)).size,
      oldestQueuedLagMs: lagMs,
    },
    "Dispatching message jobs",
  );

  for (const row of batch) {
    await dispatchOne({
      model: Message,
      extraFilter: messageDispatchStatusFilter,
      row,
      queue: messageQueue,
      owner,
      buildJob: (r) => ({
        name: r.type,
        data: { messageId: String(r._id) },
        jobId: String(r._id),
      }),
    });
  }
}

async function dispatchOutbox(outboxQueue, owner) {
  if (!outboxQueue) return;
  const now = new Date();
  const baseFilter = {
    status: JobStatus.QUEUED,
    availableAt: { $lte: now },
    topic: { $ne: "message.send" },
    ...dispatchClaimEligibleFilter(now),
  };
  const rows = await OutboxEvent.find(baseFilter)
    .sort({ createdAt: 1 })
    .limit(100)
    .select("_id topic tenantId createdAt")
    .lean();
  for (const row of rows) {
    await dispatchOne({
      model: OutboxEvent,
      extraFilter: { status: JobStatus.QUEUED, availableAt: { $lte: now }, topic: { $ne: "message.send" } },
      row,
      queue: outboxQueue,
      owner,
      buildJob: (r) => ({
        name: r.topic,
        data: { outboxEventId: String(r._id) },
        jobId: String(r._id),
        backoffDelay: 2000,
      }),
    });
  }
}

async function dispatchWebhooks(webhookQueue, owner) {
  if (!webhookQueue) return;
  const now = new Date();
  const baseFilter = {
    status: JobStatus.QUEUED,
    ...dispatchClaimEligibleFilter(now),
  };
  const rows = await WebhookEvent.find(baseFilter)
    .sort({ createdAt: 1 })
    .limit(100)
    .select("_id provider tenantId createdAt")
    .lean();
  for (const row of rows) {
    await dispatchOne({
      model: WebhookEvent,
      extraFilter: { status: JobStatus.QUEUED },
      row,
      queue: webhookQueue,
      owner,
      buildJob: (r) => ({
        name: r.provider,
        data: { webhookEventId: String(r._id) },
        jobId: String(r._id),
      }),
    });
  }
}

export async function runDispatchCycle() {
  const outboxQueue = getQueue("outbox");
  const messageQueue = getQueue("messages");
  const webhookQueue = getQueue("webhooks");
  if (!outboxQueue || !messageQueue || !webhookQueue) return;
  const owner = dispatchOwner();
  await dispatchOutbox(outboxQueue, owner);
  await dispatchMessages(messageQueue, owner);
  await dispatchWebhooks(webhookQueue, owner);
}
