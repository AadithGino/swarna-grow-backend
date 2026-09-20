import { JobStatus, PushDeviceDeliveryStatus } from "../constants/enums.js";
import { env } from "../config/env.js";
import {
  messageDispatchStatusFilter,
  reclaimExpiredDispatchLeases,
} from "../lib/dispatch-lease.js";
import { incrementOpsMetric, OpsMetric } from "../lib/ops-metrics.js";
import { Message, OutboxEvent, PushDeviceDelivery, WebhookEvent } from "../models/index.js";
import { reconcileLegacyMessageSendOutboxBatch } from "../lib/legacy-message-send-outbox.js";
import { recoverActivePushBroadcastFanouts } from "./push-broadcast.service.js";

function reclaimBatchLimit() {
  return env.DISPATCH_RECLAIM_BATCH_SIZE ?? 200;
}

export async function reclaimPushDeviceDeliveryClaims(limit = reclaimBatchLimit()) {
  const now = new Date();
  const rows = await PushDeviceDelivery.find({
    status: PushDeviceDeliveryStatus.PROCESSING,
    claimExpiresAt: { $lte: now },
  })
    .sort({ claimExpiresAt: 1 })
    .limit(limit)
    .select("_id tenantId messageId claimExpiresAt")
    .lean();

  let reclaimed = 0;
  for (const row of rows) {
    const result = await PushDeviceDelivery.updateOne(
      {
        _id: row._id,
        status: PushDeviceDeliveryStatus.PROCESSING,
        claimExpiresAt: { $lte: now },
      },
      {
        $set: { status: PushDeviceDeliveryStatus.RETRYABLE_FAILED },
        $unset: { claimToken: "", claimExpiresAt: "" },
      },
    );
    if (result.modifiedCount) reclaimed += 1;
  }
  if (reclaimed) incrementOpsMetric(OpsMetric.DISPATCH_LEASE_RECLAIMED, reclaimed);
  return reclaimed;
}

export async function runDispatchLeaseReclamation() {
  const limit = reclaimBatchLimit();
  const [messages, outbox, webhooks, broadcasts, deliveries, legacyOutbox] = await Promise.all([
    reclaimExpiredDispatchLeases(Message, messageDispatchStatusFilter, limit),
    reclaimExpiredDispatchLeases(
      OutboxEvent,
      { status: JobStatus.QUEUED, availableAt: { $lte: new Date() } },
      limit,
    ),
    reclaimExpiredDispatchLeases(WebhookEvent, { status: JobStatus.QUEUED }, limit),
    recoverActivePushBroadcastFanouts({ limit: Math.min(limit, 50) }).then((r) => r.enqueued ?? 0),
    reclaimPushDeviceDeliveryClaims(limit),
    reconcileLegacyMessageSendOutboxBatch().then((r) => r.completed),
  ]);
  return { messages, outbox, webhooks, broadcasts, deliveries, legacyOutbox };
}
