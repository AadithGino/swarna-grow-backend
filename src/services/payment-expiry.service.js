import { PaymentIntentStatus, PaymentMode, PaymentStatus } from "../constants/enums.js";
import { env } from "../config/env.js";
import { incrementOpsMetric, OpsMetric } from "../lib/ops-metrics.js";
import {
  MaintenanceScanStream,
  runRotatingMaintenanceScan,
} from "../lib/maintenance-scan-cursor.js";
import { Payment, PaymentIntent, PaymentLink } from "../models/index.js";
import { reconcileGatewayPayment } from "./phonepe-reconcile.service.js";

const TERMINAL_RECONCILE_OUTCOMES = new Set([
  "COMPLETED",
  "TERMINAL_FAILED",
  "AMOUNT_MISMATCH",
  "COMPLETED_ALREADY",
]);

function batchSize() {
  return env.PAYMENT_EXPIRY_BATCH_SIZE ?? 100;
}

function maxBatchesPerRun() {
  return env.PAYMENT_EXPIRY_MAX_BATCHES_PER_RUN ?? 20;
}

function reconcileCacheKey(tenantId, paymentId) {
  return `${tenantId}:${paymentId}`;
}

function evaluateGatewayExpiryAfterReconcile(reconcileResult, refreshedPayment) {
  if (refreshedPayment?.status === PaymentStatus.SUCCESS) {
    return { expire: false, reason: "RECONCILED_SUCCESS", reconcileResult };
  }
  if (refreshedPayment?.status === PaymentStatus.FAILED
    || refreshedPayment?.status === PaymentStatus.AMOUNT_MISMATCH_PENDING_REVIEW) {
    return { expire: false, reason: "RECONCILED_TERMINAL", reconcileResult };
  }
  if (TERMINAL_RECONCILE_OUTCOMES.has(reconcileResult.outcome)) {
    return { expire: false, reason: `RECONCILE_${reconcileResult.outcome}`, reconcileResult };
  }
  return { expire: false, reason: "RECONCILE_DEFERRED", reconcileResult };
}

async function reconcileGatewayForExpiryRun(payment, reconcileRunCache) {
  const key = reconcileCacheKey(payment.tenantId, payment._id);
  if (!reconcileRunCache.has(key)) {
    reconcileRunCache.set(
      key,
      (async () => {
        const reconcileResult = await reconcileGatewayPayment(payment, {
          source: "EXPIRE_JOB",
          leaseWorkerLabel: "expire",
        });
        const refreshedPayment = await Payment.findOne({
          _id: payment._id,
          tenantId: payment.tenantId,
        }).lean();
        return { reconcileResult, refreshedPayment };
      })(),
    );
  }
  return reconcileRunCache.get(key);
}

async function expireIntentOnly(intent) {
  const claimed = await PaymentIntent.findOneAndUpdate(
    { _id: intent._id, tenantId: intent.tenantId, status: PaymentIntentStatus.PENDING },
    { $set: { status: PaymentIntentStatus.EXPIRED }, $inc: { version: 1 } },
    { new: true },
  );
  return Boolean(claimed);
}

async function cachedExpiryReconcile(tenantId, paymentId, reconcileRunCache) {
  const key = reconcileCacheKey(tenantId, paymentId);
  if (reconcileRunCache.has(key)) {
    return reconcileRunCache.get(key);
  }
  return null;
}

async function expireIntentReservation(intent, reconcileRunCache) {
  if (intent.paymentId) {
    const cached = await cachedExpiryReconcile(
      intent.tenantId,
      intent.paymentId,
      reconcileRunCache,
    );
    if (cached) {
      const { reconcileResult, refreshedPayment } = await cached;
      const decision = evaluateGatewayExpiryAfterReconcile(reconcileResult, refreshedPayment);
      return { expired: false, ...decision };
    }
    const payment = await Payment.findOne({
      _id: intent.paymentId,
      tenantId: intent.tenantId,
    }).lean();
    if (
      payment
      && payment.status === PaymentStatus.PENDING
      && payment.mode === PaymentMode.ONLINE_GATEWAY
    ) {
      const { reconcileResult, refreshedPayment } = await reconcileGatewayForExpiryRun(
        payment,
        reconcileRunCache,
      );
      const decision = evaluateGatewayExpiryAfterReconcile(reconcileResult, refreshedPayment);
      if (!decision.expire) {
        return { expired: false, ...decision };
      }
    }
  }

  const expired = await expireIntentOnly(intent);
  if (expired) {
    await afterGatewayReservationExpired({
      tenantId: intent.tenantId,
      schemeId: intent.schemeId,
    });
  }
  return { expired, reason: expired ? "INTENT_EXPIRED" : "INTENT_NOT_EXPIRED" };
}

async function afterGatewayReservationExpired({ tenantId, schemeId }) {
  if (!schemeId) return;
  const { expirePendingEnrolmentIfUnpaid } = await import("../lib/pending-enrolment-expiry.js");
  await expirePendingEnrolmentIfUnpaid({ tenantId, schemeId });
}

async function expireLinkOnly(link) {
  const updated = await PaymentLink.updateOne(
    {
      _id: link._id,
      tenantId: link.tenantId,
      status: { $in: ["CREATED", "SENT", "OPENED"] },
    },
    { $set: { status: "EXPIRED" } },
  );
  return updated.modifiedCount > 0;
}

async function expireLinkReservation(link, reconcileRunCache) {
  if (link.paymentId) {
    const cached = await cachedExpiryReconcile(
      link.tenantId,
      link.paymentId,
      reconcileRunCache,
    );
    if (cached) {
      const { reconcileResult, refreshedPayment } = await cached;
      const decision = evaluateGatewayExpiryAfterReconcile(reconcileResult, refreshedPayment);
      return { expired: false, ...decision };
    }
    const payment = await Payment.findOne({
      _id: link.paymentId,
      tenantId: link.tenantId,
    }).lean();
    if (
      payment
      && payment.status === PaymentStatus.PENDING
      && payment.mode === PaymentMode.ONLINE_GATEWAY
    ) {
      const { reconcileResult, refreshedPayment } = await reconcileGatewayForExpiryRun(
        payment,
        reconcileRunCache,
      );
      const decision = evaluateGatewayExpiryAfterReconcile(reconcileResult, refreshedPayment);
      if (!decision.expire) {
        return { expired: false, ...decision };
      }
    }
  }
  const expired = await expireLinkOnly(link);
  if (expired) {
    await afterGatewayReservationExpired({
      tenantId: link.tenantId,
      schemeId: link.schemeId,
    });
  }
  return { expired, reason: expired ? "LINK_EXPIRED" : "LINK_NOT_EXPIRED" };
}

async function runIntentExpiryBatch(now, cursor, reconcileRunCache, limitOverride = null) {
  const limit = limitOverride ?? batchSize();
  const query = {
    status: PaymentIntentStatus.PENDING,
    reservationExpiresAt: { $lt: now },
    ...(cursor ? { _id: { $gt: cursor } } : {}),
  };
  const batch = await PaymentIntent.find(query).sort({ _id: 1 }).limit(limit).lean();
  let processed = 0;
  let expired = 0;
  let deferred = 0;
  let conflicted = 0;
  for (const intent of batch) {
    processed += 1;
    const result = await expireIntentReservation(intent, reconcileRunCache);
    if (result.expired) expired += 1;
    else if (result.reason?.startsWith("RECONCILE_")) deferred += 1;
    else if (result.reason === "INTENT_NOT_EXPIRED") conflicted += 1;
  }
  return {
    processed,
    scanned: batch.length,
    skipped: deferred,
    conflicted,
    expired,
    deferred,
    lastCursor: batch.length ? batch[batch.length - 1]._id : cursor,
    hasMore: batch.length === limit,
  };
}

async function runLinkExpiryBatch(now, cursor, reconcileRunCache, limitOverride = null) {
  const limit = limitOverride ?? batchSize();
  const linkQuery = {
    status: { $in: ["CREATED", "SENT", "OPENED"] },
    expiresAt: { $lt: now },
    ...(cursor ? { _id: { $gt: cursor } } : {}),
  };
  const links = await PaymentLink.find(linkQuery).sort({ _id: 1 }).limit(limit).lean();
  let processed = 0;
  let expired = 0;
  let deferred = 0;
  let conflicted = 0;
  for (const link of links) {
    processed += 1;
    const result = await expireLinkReservation(link, reconcileRunCache);
    if (result.expired) expired += 1;
    else if (result.reason?.startsWith("RECONCILE_")) deferred += 1;
    else if (result.reason === "LINK_NOT_EXPIRED") conflicted += 1;
  }
  return {
    processed,
    scanned: links.length,
    skipped: deferred,
    conflicted,
    expired,
    deferred,
    lastCursor: links.length ? links[links.length - 1]._id : cursor,
    hasMore: links.length === limit,
  };
}

export async function runPaymentExpiry(now = new Date(), options = {}) {
  const reconcileRunCache = new Map();
  const maxBatches = options.maxBatches ?? maxBatchesPerRun();
  const rowLimit = options.batchSize ?? null;

  const intentRotation = await runRotatingMaintenanceScan({
    stream: MaintenanceScanStream.PAYMENT_EXPIRY_INTENT,
    maxBatches,
    runBatch: (cursor) => runIntentExpiryBatch(now, cursor, reconcileRunCache, rowLimit),
  });

  const linkRotation = await runRotatingMaintenanceScan({
    stream: MaintenanceScanStream.PAYMENT_EXPIRY_LINK,
    maxBatches,
    runBatch: (cursor) => runLinkExpiryBatch(now, cursor, reconcileRunCache, rowLimit),
  });

  const intentsProcessed = intentRotation.processed;
  const linksProcessed = linkRotation.processed;
  const intentsExpired = intentRotation.expired ?? 0;
  const linksExpired = linkRotation.expired ?? 0;
  const intentsDeferred = intentRotation.deferred ?? 0;
  const linksDeferred = linkRotation.deferred ?? 0;
  const processed = intentsProcessed + linksProcessed;
  const expired = intentsExpired + linksExpired;
  const deferred = intentsDeferred + linksDeferred;
  const remainingBacklog = (intentRotation.remainingBacklog ? 1 : 0)
    + (linkRotation.remainingBacklog ? 1 : 0);

  if (processed) incrementOpsMetric(OpsMetric.PAYMENT_EXPIRY_PROCESSED, processed);
  if (expired) incrementOpsMetric(OpsMetric.PAYMENT_EXPIRY_EXPIRED, expired);
  if (deferred) incrementOpsMetric(OpsMetric.PAYMENT_EXPIRY_DEFERRED, deferred);
  if (remainingBacklog) incrementOpsMetric(OpsMetric.PAYMENT_EXPIRY_BACKLOG, remainingBacklog);

  return {
    processed,
    expired,
    deferred,
    intentsProcessed,
    linksProcessed,
    intentsExpired,
    linksExpired,
    intentsDeferred,
    linksDeferred,
    remainingBacklog,
    continuationScheduled: (intentRotation.continuationScheduled ? 1 : 0)
      + (linkRotation.continuationScheduled ? 1 : 0),
    intentRotation,
    linkRotation,
  };
}
