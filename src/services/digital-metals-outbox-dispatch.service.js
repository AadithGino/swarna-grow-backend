import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { randomToken } from "../lib/crypto.js";
import { DIGITAL_METAL_OUTBOX_TOPICS } from "../lib/digital-metals-outbox.js";
import { DigitalMetalOutboxEvent } from "../models/index.js";
import { classifyDigitalMetalOutboxDispatchOutcome } from "../lib/digital-metals-outbox-dispatch-outcomes.js";
import { processDigitalMetalCustomerNoticeOutboxEvent } from "../lib/digital-metals-notification-processor.js";
import { reconcileMissingDigitalMetalNotificationIntents } from "./digital-metals-notification-intent-reconcile.service.js";
import { processDigitalMetalPurchaseInvoiceRequest } from "./digital-metals-invoice.service.js";
import { processDigitalMetalDocumentArtifactRequest } from "./digital-metals-document-artifact.service.js";

function batchSize() {
  return env.DIGITAL_METALS_OUTBOX_BATCH_SIZE ?? 40;
}

function leaseMs() {
  return env.DIGITAL_METALS_OUTBOX_LEASE_MS ?? 90_000;
}

function backoffNext(attempts) {
  const sec = Math.min(1800, 30 * 2 ** Math.min(attempts, 5));
  return new Date(Date.now() + sec * 1000);
}

function buildLease(eventId) {
  return `dmobx_${eventId}_${randomToken(6)}`;
}

async function claimOutboxEvent(eventId, at = new Date()) {
  const leaseOwner = buildLease(eventId);
  return DigitalMetalOutboxEvent.findOneAndUpdate(
    {
      _id: eventId,
      status: "PENDING",
      availableAt: { $lte: at },
      $or: [
        { dispatchLeaseExpiresAt: { $lte: at } },
        { dispatchLeaseExpiresAt: null },
        { dispatchLeaseExpiresAt: { $exists: false } },
      ],
    },
    {
      $set: {
        status: "PROCESSING",
        dispatchLeaseOwner: leaseOwner,
        dispatchLeaseExpiresAt: new Date(at.getTime() + leaseMs()),
      },
    },
    { new: true },
  ).lean();
}

async function markProcessed(eventId, leaseOwner, classified, diagnostic = null) {
  const outcome = classified?.outcome ?? classified;
  const disposition = classified?.disposition ?? "COMPLETED";
  await DigitalMetalOutboxEvent.updateOne(
    { _id: eventId, dispatchLeaseOwner: leaseOwner },
    {
      $set: {
        status: "PROCESSED",
        processedAt: new Date(),
        processedOutcome: outcome ?? null,
        processedDisposition: disposition,
        processedSkipReason: disposition === "SKIPPED" ? (classified?.skipReason ?? outcome) : null,
        dispatchLeaseOwner: null,
        dispatchLeaseExpiresAt: null,
        lastError: diagnostic ? String(diagnostic).slice(0, 500) : null,
      },
    },
  );
}

async function markFailed(event, leaseOwner, message) {
  const attempts = (event.dispatchAttempts ?? 0) + 1;
  const giveUp = attempts >= (env.DIGITAL_METALS_OUTBOX_MAX_ATTEMPTS ?? 8);
  await DigitalMetalOutboxEvent.updateOne(
    { _id: event._id, dispatchLeaseOwner: leaseOwner },
    {
      $set: {
        status: giveUp ? "FAILED" : "PENDING",
        dispatchAttempts: attempts,
        dispatchLeaseOwner: null,
        dispatchLeaseExpiresAt: null,
        availableAt: giveUp ? event.availableAt : backoffNext(attempts),
        lastError: String(message ?? "unknown").slice(0, 500),
      },
    },
  );
}

async function dispatchOne(event) {
  if (event.topic === DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_INVOICE_REQUEST) {
    const orderId = event.payload?.orderId;
    if (!orderId) return { outcome: "INVALID_PAYLOAD" };
    return processDigitalMetalPurchaseInvoiceRequest({
      tenantId: event.tenantId,
      orderId,
    });
  }
  if (event.topic === DIGITAL_METAL_OUTBOX_TOPICS.DOCUMENT_ARTIFACT_REQUEST) {
    const artifactId = event.payload?.artifactId;
    if (!artifactId) return { outcome: "INVALID_PAYLOAD" };
    return processDigitalMetalDocumentArtifactRequest({
      tenantId: event.tenantId,
      artifactId,
    });
  }
  const notice = await processDigitalMetalCustomerNoticeOutboxEvent(event);
  if (notice.outcome !== "NOT_A_NOTICE_TOPIC") {
    return notice;
  }
  return { outcome: "UNKNOWN_TOPIC" };
}

async function reclaimStaleProcessingOutbox(at = new Date()) {
  const result = await DigitalMetalOutboxEvent.updateMany(
    {
      status: "PROCESSING",
      dispatchLeaseExpiresAt: { $lte: at },
    },
    {
      $set: {
        status: "PENDING",
        dispatchLeaseOwner: null,
        dispatchLeaseExpiresAt: null,
      },
    },
  );
  return result.modifiedCount ?? 0;
}

export async function runDigitalMetalOutboxDispatch(at = new Date()) {
  const intentRepair = await reconcileMissingDigitalMetalNotificationIntents({ at, limit: 25 });
  const reclaimed = await reclaimStaleProcessingOutbox(at);
  const rows = await DigitalMetalOutboxEvent.find({
    status: "PENDING",
    availableAt: { $lte: at },
    $or: [
      { dispatchLeaseExpiresAt: { $lte: at } },
      { dispatchLeaseExpiresAt: null },
      { dispatchLeaseExpiresAt: { $exists: false } },
    ],
  })
    .sort({ availableAt: 1, createdAt: 1 })
    .limit(batchSize())
    .lean();

  const summary = { scanned: rows.length, outcomes: {}, dispositions: {} };
  if (intentRepair?.repaired) summary.intentRepair = intentRepair;
  for (const row of rows) {
    const claimed = await claimOutboxEvent(row._id, at);
    if (!claimed) {
      summary.outcomes.LEASE_NOT_ACQUIRED = (summary.outcomes.LEASE_NOT_ACQUIRED ?? 0) + 1;
      continue;
    }
    const leaseOwner = claimed.dispatchLeaseOwner;
    try {
      const result = await dispatchOne(claimed);
      const key = result.outcome ?? "UNKNOWN";
      summary.outcomes[key] = (summary.outcomes[key] ?? 0) + 1;
      const classified = classifyDigitalMetalOutboxDispatchOutcome(result);
      summary.dispositions[classified.disposition] = (summary.dispositions[classified.disposition] ?? 0) + 1;
      if (classified.retryable) {
        await markFailed(claimed, leaseOwner, result.error ?? key);
      } else if (classified.terminal) {
        await markFailed(claimed, leaseOwner, result.error ?? key);
      } else if (classified.disposition === "SKIPPED") {
        await markProcessed(claimed._id, leaseOwner, classified, `SKIPPED:${key}`);
      } else {
        await markProcessed(claimed._id, leaseOwner, classified);
      }
    } catch (err) {
      logger.warn({ eventId: claimed._id, err: err?.message }, "Digital metal outbox dispatch error");
      await markFailed(claimed, leaseOwner, err?.message);
      summary.outcomes.ERROR = (summary.outcomes.ERROR ?? 0) + 1;
      summary.dispositions.RETRYABLE = (summary.dispositions.RETRYABLE ?? 0) + 1;
    }
  }
  if (reclaimed) summary.reclaimedStale = reclaimed;
  return summary;
}
