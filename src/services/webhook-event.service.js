import { env } from "../config/env.js";
import { DispatchState, JobStatus } from "../constants/enums.js";
import { sha256 } from "../lib/crypto.js";
import { createId } from "../lib/ids.js";
import { incrementOpsMetric, OpsMetric } from "../lib/ops-metrics.js";
import { incrementWebhookMetric, WebhookMetric } from "../lib/webhook-metrics.js";
import { WebhookEvent } from "../models/index.js";

function signatureFailureRetentionDate() {
  const sec = env.WEBHOOK_SIGNATURE_FAILURE_RETENTION_SEC ?? 86_400;
  return new Date(Date.now() + sec * 1000);
}

function verifiedRawRetentionDate() {
  const sec = env.WEBHOOK_RAW_RETENTION_SEC ?? 604_800;
  return new Date(Date.now() + sec * 1000);
}

function completedRetentionDate() {
  const sec = env.WEBHOOK_COMPLETED_RETENTION_SEC ?? 2_592_000;
  return new Date(Date.now() + sec * 1000);
}

export function digestWebhookBody(rawBody) {
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ""), "utf8");
  return sha256(buf);
}

export function digestWebhookSignature(signatureHeader) {
  if (!signatureHeader) return null;
  return sha256(String(signatureHeader));
}

/**
 * Persist a verified webhook (payload already validated). Stores raw body until worker completes.
 */
export async function persistVerifiedWebhook({
  tenantId,
  provider,
  providerEventId,
  signatureHeader = null,
  rawBody = null,
  payload,
}) {
  try {
    const event = await WebhookEvent.create({
      _id: createId("webhook"),
      tenantId,
      provider,
      providerEventId,
      bodyDigest: rawBody ? digestWebhookBody(rawBody) : null,
      signatureDigest: digestWebhookSignature(signatureHeader),
      rawBody: rawBody ?? undefined,
      payload,
      purgeAt: verifiedRawRetentionDate(),
    });
    incrementWebhookMetric(WebhookMetric.RECEIVED);
    return event;
  } catch (error) {
    if (error.code === 11000) {
      incrementWebhookMetric(WebhookMetric.DUPLICATE);
      return null;
    }
    throw error;
  }
}

/** Bounded metadata only — no raw body or signature secrets. */
export async function persistWebhookSignatureFailure({
  tenantId,
  provider,
  rawBody,
  signatureHeader = null,
  clientIp = null,
}) {
  const bodyDigest = digestWebhookBody(rawBody);
  const providerEventId = `sigfail:${provider}:${tenantId}:${bodyDigest.slice(0, 40)}`;
  try {
    const event = await WebhookEvent.create({
      _id: createId("webhook"),
      tenantId,
      provider,
      providerEventId,
      bodyDigest,
      signatureDigest: digestWebhookSignature(signatureHeader),
      payload: {
        kind: "SIGNATURE_FAILURE",
        clientIp: clientIp ?? undefined,
      },
      status: JobStatus.SIGNATURE_FAILED,
      error: "Invalid webhook signature",
      purgeAt: signatureFailureRetentionDate(),
    });
    incrementWebhookMetric(WebhookMetric.SIGNATURE_FAILED);
    return event;
  } catch (error) {
    if (error.code === 11000) return null;
    throw error;
  }
}

export async function finalizeWebhookStorage(eventId) {
  await WebhookEvent.updateOne(
    { _id: eventId },
    {
      $set: { purgeAt: completedRetentionDate() },
      $unset: { rawBody: "" },
    },
  );
}

export async function reclaimExpiredWebhookLeases() {
  const now = new Date();
  const batchSize = env.WEBHOOK_RECLAIM_BATCH_SIZE ?? 100;
  const maxBatches = env.WEBHOOK_RECLAIM_MAX_BATCHES_PER_RUN ?? 10;
  let reclaimed = 0;
  let conflicted = 0;
  let cursor = null;
  let backlog = false;

  for (let batchIdx = 0; batchIdx < maxBatches; batchIdx += 1) {
    const candidates = await WebhookEvent.find({
      status: JobStatus.PROCESSING,
      leaseExpiresAt: { $lte: now },
      ...(cursor ? { _id: { $gt: cursor } } : {}),
    })
      .sort({ _id: 1 })
      .limit(batchSize)
      .select("_id")
      .lean();

    if (!candidates.length) break;

    for (const row of candidates) {
      const result = await WebhookEvent.updateOne(
        {
          _id: row._id,
          status: JobStatus.PROCESSING,
          leaseExpiresAt: { $lte: now },
        },
        {
          $set: {
            status: JobStatus.QUEUED,
            error: "PROCESSING_LEASE_EXPIRED",
          },
          $unset: {
            leaseOwner: "",
            lockedAt: "",
            leaseExpiresAt: "",
            enqueuedAt: "",
          },
        },
      );
      if (result.modifiedCount) reclaimed += 1;
      else conflicted += 1;
    }

    cursor = candidates[candidates.length - 1]._id;
    if (candidates.length < batchSize) break;
    if (batchIdx + 1 >= maxBatches) backlog = true;
  }

  if (reclaimed) {
    incrementWebhookMetric(WebhookMetric.LEASE_RECLAIMED, reclaimed);
    incrementOpsMetric(OpsMetric.WEBHOOK_RECLAIM_RECLAIMED, reclaimed);
  }
  if (conflicted) incrementOpsMetric(OpsMetric.WEBHOOK_RECLAIM_CONFLICTED, conflicted);
  if (backlog) incrementOpsMetric(OpsMetric.WEBHOOK_RECLAIM_BACKLOG, 1);

  return {
    reclaimed,
    conflicted,
    failed: 0,
    remainingBacklog: backlog ? 1 : 0,
    continuationScheduled: backlog ? 1 : 0,
  };
}

export async function claimWebhookForProcessing(webhookEventId, leaseOwner) {
  const now = new Date();
  const leaseMs = env.WEBHOOK_PROCESSING_LEASE_MS ?? 300_000;
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  return WebhookEvent.findOneAndUpdate(
    {
      _id: webhookEventId,
      $or: [
        { status: { $in: [JobStatus.QUEUED, JobStatus.FAILED] } },
        {
          status: JobStatus.PROCESSING,
          leaseExpiresAt: { $lte: now },
        },
      ],
    },
    {
      $set: {
        status: JobStatus.PROCESSING,
        lockedAt: now,
        leaseOwner,
        leaseExpiresAt,
      },
      $inc: { attempts: 1 },
    },
    { new: true },
  );
}

export async function replayWebhookEvent({ tenantId, webhookEventId }) {
  const event = await WebhookEvent.findOne({
    _id: webhookEventId,
    tenantId,
    status: { $in: [JobStatus.FAILED, JobStatus.DEAD_LETTER] },
  });
  if (!event) return null;
  await WebhookEvent.updateOne(
    { _id: event._id },
    {
      $set: {
        status: JobStatus.QUEUED,
        error: null,
        dispatchState: DispatchState.PENDING,
      },
      $unset: {
        enqueuedAt: "",
        processedAt: "",
        leaseOwner: "",
        lockedAt: "",
        leaseExpiresAt: "",
        dispatchLeaseOwner: "",
        dispatchLeaseExpiresAt: "",
        dispatchedAt: "",
      },
    },
  );
  incrementWebhookMetric(WebhookMetric.REPLAY);
  return event;
}
