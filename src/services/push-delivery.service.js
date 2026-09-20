import { env } from "../config/env.js";
import { PushDeviceDeliveryStatus } from "../constants/enums.js";
import { randomToken } from "../lib/crypto.js";
import { PushOutcomeKind } from "../lib/fcm-outcomes.js";
import { incrementOpsMetric, OpsMetric } from "../lib/ops-metrics.js";
import { createId } from "../lib/ids.js";
import { Alert, Message, PushDeviceDelivery } from "../models/index.js";

const MESSAGE_TERMINAL_STATUSES = new Set(["SENT", "DELIVERED", "READ"]);

const TERMINAL_DELIVERY = [
  PushDeviceDeliveryStatus.SUCCEEDED,
  PushDeviceDeliveryStatus.PERMANENT_FAILED,
  PushDeviceDeliveryStatus.DEAD_LETTER,
];

export const PushDeliveryApplyResult = Object.freeze({
  APPLIED: "APPLIED",
  CLAIM_LOST: "CLAIM_LOST",
  SKIPPED: "SKIPPED",
});

function claimLeaseMs() {
  return env.FCM_DELIVERY_CLAIM_MS ?? 120_000;
}

function claimableFilter(now) {
  return {
    $or: [
      { status: PushDeviceDeliveryStatus.QUEUED },
      { status: PushDeviceDeliveryStatus.RETRYABLE_FAILED },
      {
        status: PushDeviceDeliveryStatus.PROCESSING,
        claimExpiresAt: { $lte: now },
      },
    ],
  };
}

export async function ensurePushDeliveries({ tenantId, messageId, devices }) {
  const ops = devices.map((device) => ({
    updateOne: {
      filter: {
        tenantId,
        messageId,
        deviceRegistrationId: device.deviceRegistrationId ?? `legacy:${device.tokenHash}`,
      },
      update: {
        $setOnInsert: {
          _id: createId("pdd"),
          tenantId,
          messageId,
          deviceRegistrationId: device.deviceRegistrationId ?? `legacy:${device.tokenHash}`,
          status: PushDeviceDeliveryStatus.QUEUED,
          attemptCount: 0,
        },
      },
      upsert: true,
    },
  }));
  if (ops.length) await PushDeviceDelivery.bulkWrite(ops, { ordered: false });
}

export async function listDeliveriesToSend(messageId, tenantId) {
  const now = new Date();
  return PushDeviceDelivery.find({
    tenantId,
    messageId,
    ...claimableFilter(now),
  }).lean();
}

export async function claimDeliveriesForProcessing({ tenantId, messageId, deviceRegistrationIds }) {
  if (!deviceRegistrationIds.length) return [];
  const claimed = [];
  const now = new Date();
  const claimExpiresAt = new Date(now.getTime() + claimLeaseMs());
  for (const deviceRegistrationId of deviceRegistrationIds) {
    const claimToken = `${messageId}_${deviceRegistrationId}_${randomToken(8)}`;
    const row = await PushDeviceDelivery.findOneAndUpdate(
      {
        tenantId,
        messageId,
        deviceRegistrationId,
        ...claimableFilter(now),
      },
      {
        $set: {
          status: PushDeviceDeliveryStatus.PROCESSING,
          lastAttemptAt: now,
          claimToken,
          claimExpiresAt,
        },
        $inc: { attemptCount: 1 },
      },
      { new: true },
    ).lean();
    if (row) claimed.push(row);
  }
  return claimed;
}

function deliveryStatusForOutcome(outcome, attemptCount) {
  if (outcome.kind === PushOutcomeKind.SUCCESS) {
    return PushDeviceDeliveryStatus.SUCCEEDED;
  }
  if (outcome.kind === PushOutcomeKind.PERMANENT_INVALID_TOKEN
    || outcome.kind === PushOutcomeKind.PERMANENT_PAYLOAD_ERROR) {
    return PushDeviceDeliveryStatus.PERMANENT_FAILED;
  }
  const maxAttempts = env.FCM_MAX_ATTEMPTS ?? 3;
  if (attemptCount >= maxAttempts) return PushDeviceDeliveryStatus.DEAD_LETTER;
  return PushDeviceDeliveryStatus.RETRYABLE_FAILED;
}

async function upsertDeliveryExhaustedAlert({ tenantId, messageId, attempts }) {
  await Alert.findOneAndUpdate(
    {
      tenantId,
      type: "FCM_DELIVERY_EXHAUSTED",
      entityId: messageId,
      status: "OPEN",
    },
    {
      $setOnInsert: {
        severity: "HIGH",
        title: "FCM delivery retries exhausted",
        message: "One or more device deliveries reached the retry limit for this message.",
        entityType: "MESSAGE",
        metadata: { attempts },
      },
    },
    { upsert: true },
  );
  incrementOpsMetric(OpsMetric.FCM_DELIVERY_EXHAUSTED_ALERT);
}

export async function summarizePushDeliveries({ tenantId, messageId }) {
  const now = new Date();
  const rows = await PushDeviceDelivery.aggregate([
    { $match: { tenantId, messageId } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const byStatus = Object.fromEntries(rows.map((row) => [row._id, row.count]));
  const processingActive = await PushDeviceDelivery.countDocuments({
    tenantId,
    messageId,
    status: PushDeviceDeliveryStatus.PROCESSING,
    claimExpiresAt: { $gt: now },
  });
  return {
    queued: Number(byStatus[PushDeviceDeliveryStatus.QUEUED] ?? 0),
    processingActive,
    retryableFailed: Number(byStatus[PushDeviceDeliveryStatus.RETRYABLE_FAILED] ?? 0),
    succeeded: Number(byStatus[PushDeviceDeliveryStatus.SUCCEEDED] ?? 0),
    permanentFailed: Number(byStatus[PushDeviceDeliveryStatus.PERMANENT_FAILED] ?? 0),
    deadLetter: Number(byStatus[PushDeviceDeliveryStatus.DEAD_LETTER] ?? 0),
  };
}

export async function applyPushOutcomes({ tenantId, messageId, outcomes }) {
  const { fcmPushTestHookBeforeApplyPushOutcome } = await import("../lib/fcm-push-test-hooks.js");
  await fcmPushTestHookBeforeApplyPushOutcome();
  const results = [];
  for (const outcome of outcomes) {
    const registrationKey = outcome.deviceRegistrationId
      ?? (outcome.tokenHash ? `legacy:${outcome.tokenHash}` : null);
    const claimToken = outcome.claimToken;
    if (!registrationKey || !claimToken) {
      results.push({ deviceRegistrationId: registrationKey, result: PushDeliveryApplyResult.SKIPPED });
      continue;
    }
    const existing = await PushDeviceDelivery.findOne({
      tenantId,
      messageId,
      deviceRegistrationId: registrationKey,
    }).lean();
    if (existing && TERMINAL_DELIVERY.includes(existing.status)) {
      results.push({ deviceRegistrationId: registrationKey, result: PushDeliveryApplyResult.SKIPPED });
      continue;
    }
    const attemptCount = existing?.attemptCount ?? (outcome.attempt ?? 1);
    const status = deliveryStatusForOutcome(outcome, attemptCount);

    const updated = await PushDeviceDelivery.findOneAndUpdate(
      {
        tenantId,
        messageId,
        deviceRegistrationId: registrationKey,
        status: PushDeviceDeliveryStatus.PROCESSING,
        claimToken,
      },
      {
        $set: {
          status,
          providerMessageId: outcome.providerMessageId ?? existing?.providerMessageId,
          lastErrorKind: outcome.kind !== PushOutcomeKind.SUCCESS ? outcome.kind : null,
          lastErrorCode: outcome.errorCode ?? null,
          lastAttemptAt: new Date(),
          ...(status === PushDeviceDeliveryStatus.SUCCEEDED
            ? { succeededAt: new Date() }
            : {}),
          ...(status === PushDeviceDeliveryStatus.DEAD_LETTER
            ? { deadLetteredAt: new Date() }
            : {}),
        },
        $unset: {
          claimToken: "",
          claimExpiresAt: "",
        },
      },
      { new: true },
    ).lean();
    if (!updated) {
      results.push({ deviceRegistrationId: registrationKey, result: PushDeliveryApplyResult.CLAIM_LOST });
      continue;
    }
    results.push({
      deviceRegistrationId: registrationKey,
      result: PushDeliveryApplyResult.APPLIED,
      resultingStatus: updated.status,
      outcomeKind: outcome.kind,
    });
    if (updated.status === PushDeviceDeliveryStatus.DEAD_LETTER) {
      await upsertDeliveryExhaustedAlert({
        tenantId,
        messageId,
        attempts: updated.attemptCount ?? env.FCM_MAX_ATTEMPTS ?? 3,
      });
    }
  }
  return results;
}

export async function releaseDeferredDeliveries({ tenantId, messageId, claims }) {
  if (!claims?.length) return;
  for (const claim of claims) {
    await PushDeviceDelivery.updateOne(
      {
        tenantId,
        messageId,
        deviceRegistrationId: claim.deviceRegistrationId,
        status: PushDeviceDeliveryStatus.PROCESSING,
        claimToken: claim.claimToken,
        attemptCount: { $gte: 1 },
      },
      {
        $set: { status: PushDeviceDeliveryStatus.RETRYABLE_FAILED },
        $inc: { attemptCount: -1 },
        $unset: { claimToken: "", claimExpiresAt: "" },
      },
    );
  }
}

export async function releaseOwnedClaimsOnError({ tenantId, messageId, claims }) {
  return releaseDeferredDeliveries({ tenantId, messageId, claims });
}

export async function casFailPushMessageNoDevices({ tenantId, messageId }) {
  const updated = await Message.findOneAndUpdate(
    {
      _id: messageId,
      tenantId,
      status: { $nin: [...MESSAGE_TERMINAL_STATUSES] },
    },
    {
      $set: {
        status: "FAILED",
        failureMessage: "No registered device tokens",
        failedAt: new Date(),
        lastAttemptAt: new Date(),
      },
      $inc: { attemptCount: 1 },
    },
    { new: true },
  ).lean();
  return { applied: Boolean(updated) };
}

export async function casFinalizePushMessageFromSummary({
  tenantId,
  messageId,
  deliverySummary,
  providerMessageId,
}) {
  if (deliverySummary.processingActive > 0) return { applied: false, reason: "processing_active" };
  if (deliverySummary.queued > 0 || deliverySummary.retryableFailed > 0) {
    return { applied: false, reason: "retryable_work" };
  }
  const terminalCount = deliverySummary.succeeded
    + deliverySummary.permanentFailed
    + deliverySummary.deadLetter;
  if (terminalCount === 0) return { applied: false, reason: "no_terminal" };

  const targetStatus = deliverySummary.succeeded > 0 ? "SENT" : "FAILED";
  const update = {
    $set: {
      status: targetStatus,
      lastAttemptAt: new Date(),
      ...(targetStatus === "FAILED"
        ? {
          failureMessage: "All FCM device deliveries failed",
          failedAt: new Date(),
        }
        : {}),
      ...(providerMessageId ? { providerMessageId } : {}),
    },
    $inc: { attemptCount: 1 },
  };
  const updated = await Message.findOneAndUpdate(
    {
      _id: messageId,
      tenantId,
      status: { $nin: [...MESSAGE_TERMINAL_STATUSES] },
    },
    update,
    { new: true },
  ).lean();
  return { applied: Boolean(updated), status: updated?.status ?? null };
}

export async function reclaimStaleProcessingDeliveries({ tenantId, messageId }) {
  const now = new Date();
  await PushDeviceDelivery.updateMany(
    {
      tenantId,
      messageId,
      status: PushDeviceDeliveryStatus.PROCESSING,
      claimExpiresAt: { $lte: now },
    },
    {
      $set: { status: PushDeviceDeliveryStatus.RETRYABLE_FAILED },
      $unset: { claimToken: "", claimExpiresAt: "" },
    },
  );
}
