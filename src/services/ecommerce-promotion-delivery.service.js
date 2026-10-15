import {
  EcommerceProductStatus,
  EcommercePromotionCampaignStatus,
  EcommercePromotionKind,
  JobStatus,
  MessageStatus,
  MessageType,
  PushBroadcastSourceKind,
} from "../constants/enums.js";
import { logger } from "../config/logger.js";
import { randomToken } from "../lib/crypto.js";
import { EcommerceCategory, EcommerceProduct, EcommercePromotionCampaign, Message, PushBroadcast, Tenant } from "../models/index.js";
import { getQueue } from "../queues/index.js";
import { isEcommerceOperational } from "../lib/ecommerce-access.js";
import {
  countPushAudience,
  createEcommercePromotionBroadcast,
  schedulePushBroadcastFanoutJob,
} from "./push-broadcast.service.js";
import {
  ECOMMERCE_GOLD_RATE_DEEP_LINK,
  SCHEME_GOLD_RATE_DEEP_LINK,
  suggestEcommerceGoldRateNotificationCopy,
  suggestSchemeGoldRateNotificationCopy,
} from "../lib/gold-rate-notification-copy.js";
import {
  revalidateEcommerceGoldRateNotification,
  revalidateSchemeGoldRateNotification,
} from "../lib/gold-rate-notification-validate.js";
import { schemeRateHasAnyRecipient } from "../lib/scheme-rate-fanout-filter.js";
import { fetchAudienceCustomerPage } from "./push-broadcast.service.js";
import { ensureRunnableMaintenanceJob } from "../lib/maintenance-queue-job.js";
import {
  offerRevisionDigest,
  productShopDeepLink,
  resolveCampaignCopy,
  trimPromotionCopy,
} from "../lib/ecommerce-promotion-copy.js";

function isRateNotificationKind(kind) {
  return kind === EcommercePromotionKind.SCHEME_GOLD_RATE
    || kind === EcommercePromotionKind.ECOMMERCE_GOLD_RATE;
}

function broadcastSourceKindForCampaign(campaign) {
  return isRateNotificationKind(campaign.kind)
    ? PushBroadcastSourceKind.GOLD_RATE_NOTIFICATION
    : PushBroadcastSourceKind.ECOMMERCE_PROMOTION;
}

function dispatchReqFromCampaign(campaign, tenant) {
  return {
    auth: { tenantId: campaign.tenantId, id: campaign.requestedBy, permissions: ["*"] },
    tenant,
    scope: {
      tenantId: campaign.tenantId,
      branchId: campaign.scopeBranchId ?? campaign.branchId ?? null,
    },
  };
}

export async function revalidateCampaignTarget(campaign, tenant, atMs = Date.now()) {
  if (campaign.kind === EcommercePromotionKind.SCHEME_GOLD_RATE) {
    return revalidateSchemeGoldRateNotification(campaign, tenant);
  }
  if (campaign.kind === EcommercePromotionKind.ECOMMERCE_GOLD_RATE) {
    return revalidateEcommerceGoldRateNotification(campaign, tenant);
  }
  if (!isEcommerceOperational(tenant)) {
    return { ok: false, reason: "STORE_INACTIVE" };
  }
  if (campaign.productId) {
    const product = await EcommerceProduct.findOne({
      _id: campaign.productId,
      tenantId: campaign.tenantId,
    }).lean();
    if (!product || product.status !== EcommerceProductStatus.PUBLISHED) {
      return { ok: false, reason: "PRODUCT_NOT_PUBLISHED" };
    }
    if (product.categoryId) {
      const cat = await EcommerceCategory.findOne({
        _id: product.categoryId,
        tenantId: campaign.tenantId,
        active: true,
      }).lean();
      if (!cat) return { ok: false, reason: "CATEGORY_INACTIVE" };
    }
    if (campaign.kind === EcommercePromotionKind.OFFER) {
      const { hasNotifiableOffer } = await import("../lib/ecommerce-promotion-copy.js");
      if (!hasNotifiableOffer(product, atMs)) {
        return { ok: false, reason: "OFFER_INACTIVE" };
      }
      const digest = offerRevisionDigest(product);
      if (campaign.offerRevision && campaign.offerRevision !== digest) {
        return { ok: false, reason: "OFFER_REVISION_MISMATCH" };
      }
    }
    return { ok: true, product };
  }
  if (campaign.categoryId) {
    const category = await EcommerceCategory.findOne({
      _id: campaign.categoryId,
      tenantId: campaign.tenantId,
      active: true,
    }).lean();
    if (!category) return { ok: false, reason: "CATEGORY_INACTIVE" };
    return { ok: true, category };
  }
  return { ok: false, reason: "TARGET_MISSING" };
}

async function refreshCampaignCopyForDelivery(campaign, tenant, atMs) {
  if (campaign.kind === EcommercePromotionKind.SCHEME_GOLD_RATE) {
    const suggested = suggestSchemeGoldRateNotificationCopy({
      ratePerGramPaise: campaign.ratePerGramPaise,
      effectiveDateYmd: campaign.schemeEffectiveDate,
    });
    const copy = trimPromotionCopy(suggested.title, suggested.body);
    return { ...campaign, title: copy.title, body: copy.body, deepLink: SCHEME_GOLD_RATE_DEEP_LINK };
  }
  if (campaign.kind === EcommercePromotionKind.ECOMMERCE_GOLD_RATE) {
    const suggested = suggestEcommerceGoldRateNotificationCopy({
      purity: campaign.purity,
      ratePerGramPaise: campaign.ratePerGramPaise,
      effectiveAt: campaign.ecommerceEffectiveAt,
    });
    const copy = trimPromotionCopy(suggested.title, suggested.body);
    return { ...campaign, title: copy.title, body: copy.body, deepLink: ECOMMERCE_GOLD_RATE_DEEP_LINK };
  }
  let product = null;
  let category = null;
  if (campaign.productId) {
    product = await EcommerceProduct.findOne({
      _id: campaign.productId,
      tenantId: campaign.tenantId,
    }).lean();
    if (!product) return null;
  } else if (campaign.categoryId) {
    category = await EcommerceCategory.findOne({
      _id: campaign.categoryId,
      tenantId: campaign.tenantId,
    }).lean();
    if (!category) return null;
  }
  const copy = await resolveCampaignCopy({
    kind: campaign.kind,
    product,
    category,
    title: campaign.titleOverridden ? campaign.title : null,
    body: campaign.bodyOverridden ? campaign.body : null,
    tenantId: campaign.tenantId,
    atMs,
  });
  const deepLink = product
    ? productShopDeepLink(product.slug)
    : campaign.deepLink;
  return {
    ...campaign,
    title: campaign.titleOverridden ? campaign.title : copy.title,
    body: campaign.bodyOverridden ? campaign.body : copy.body,
    deepLink,
  };
}

export const CAMPAIGN_DELIVERY_LEASE_MS = 5 * 60 * 1000;
export const MAX_CAMPAIGN_DELIVERY_ATTEMPTS = 12;
const MAINTENANCE_SCAN_LIMIT = 50;

export const TERMINAL_CANCEL_REASONS = new Set([
  "STORE_INACTIVE",
  "PRODUCT_NOT_PUBLISHED",
  "CATEGORY_INACTIVE",
  "OFFER_INACTIVE",
  "OFFER_REVISION_MISMATCH",
  "TARGET_MISSING",
  "TENANT_MISSING",
  "NO_ELIGIBLE_DEVICES",
  "NO_ELIGIBLE_RECIPIENTS",
  "RATE_MISSING",
  "RATE_SUPERSEDED",
  "STALE_BUSINESS_DATE",
  "NOT_DUE",
  "DELIVERY_ATTEMPTS_EXCEEDED",
]);

export function isTerminalCampaignCancelReason(reason) {
  return Boolean(reason && TERMINAL_CANCEL_REASONS.has(reason));
}

export function isTransientInfrastructureError(error) {
  const code = error?.code ?? error?.name ?? "";
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENOTFOUND") return true;
  if (error?.name === "MongoServerError" && error?.hasErrorLabel?.("TransientTransactionError")) return true;
  if (String(error?.message ?? "").includes("DISPATCH_TEST")) return false;
  return false;
}

function leaseExpiresAt(from = Date.now()) {
  return new Date(from + CAMPAIGN_DELIVERY_LEASE_MS);
}

function messageTypeForKind(kind) {
  if (kind === EcommercePromotionKind.MANUAL_CATEGORY) return MessageType.ECOMMERCE_CATEGORY_PROMOTION;
  if (kind === EcommercePromotionKind.NEW_ARRIVAL) return MessageType.ECOMMERCE_NEW_ARRIVAL;
  if (kind === EcommercePromotionKind.OFFER) return MessageType.ECOMMERCE_OFFER;
  if (kind === EcommercePromotionKind.SCHEME_GOLD_RATE) return MessageType.SCHEME_GOLD_RATE_UPDATED;
  if (kind === EcommercePromotionKind.ECOMMERCE_GOLD_RATE) return MessageType.ECOMMERCE_GOLD_RATE_UPDATED;
  return MessageType.ECOMMERCE_PRODUCT_PROMOTION;
}

export async function releaseCampaignDeliveryLease(campaignId, tenantId, leaseOwner, { requeue = true } = {}) {
  await EcommercePromotionCampaign.updateOne(
    { _id: campaignId, tenantId, deliveryLeaseOwner: leaseOwner },
    {
      $set: {
        deliveryLeaseOwner: null,
        deliveryLeaseExpiresAt: null,
        ...(requeue ? { status: EcommercePromotionCampaignStatus.QUEUED } : {}),
      },
    },
  );
}

async function markCampaignCancelled(campaignId, tenantId, leaseOwner, reason) {
  await EcommercePromotionCampaign.updateOne(
    {
      _id: campaignId,
      tenantId,
      ...(leaseOwner ? { deliveryLeaseOwner: leaseOwner } : {}),
    },
    {
      $set: {
        status: EcommercePromotionCampaignStatus.CANCELLED,
        skippedReason: reason,
        deliveryLeaseOwner: null,
        deliveryLeaseExpiresAt: null,
      },
    },
  );
}

/** Claim QUEUED (due) or resume stale in-flight delivery. Does not set SENDING until broadcast exists. */
export async function claimCampaignForDelivery(campaignId, tenantId, now = new Date()) {
  const leaseOwner = `epcm:${randomToken(10)}`;
  const expires = leaseExpiresAt(now.getTime());

  let campaign = await EcommercePromotionCampaign.findOneAndUpdate(
    {
      _id: campaignId,
      tenantId,
      status: EcommercePromotionCampaignStatus.QUEUED,
      $and: [
        { $or: [{ scheduledFor: null }, { scheduledFor: { $lte: now } }] },
        {
          $or: [
            { deliveryLeaseOwner: null },
            { deliveryLeaseExpiresAt: { $lte: now } },
          ],
        },
      ],
    },
    {
      $set: {
        deliveryLeaseOwner: leaseOwner,
        deliveryLeaseExpiresAt: expires,
      },
      $inc: { deliveryAttemptCount: 1 },
    },
    { new: true },
  ).lean();

  if (campaign) {
    if ((campaign.deliveryAttemptCount ?? 0) > MAX_CAMPAIGN_DELIVERY_ATTEMPTS) {
      await markCampaignCancelled(campaignId, tenantId, leaseOwner, "DELIVERY_ATTEMPTS_EXCEEDED");
      return { cancelled: true, reason: "DELIVERY_ATTEMPTS_EXCEEDED" };
    }
    return { campaign, leaseOwner };
  }

  campaign = await EcommercePromotionCampaign.findOneAndUpdate(
    {
      _id: campaignId,
      tenantId,
      status: EcommercePromotionCampaignStatus.SENDING,
      broadcastId: null,
      deliveryLeaseExpiresAt: { $lte: now },
    },
    {
      $set: {
        status: EcommercePromotionCampaignStatus.QUEUED,
        deliveryLeaseOwner: leaseOwner,
        deliveryLeaseExpiresAt: expires,
      },
      $inc: { deliveryAttemptCount: 1 },
    },
    { new: true },
  ).lean();

  if (campaign) {
    return { campaign, leaseOwner, recoveredStale: true };
  }

  const existing = await EcommercePromotionCampaign.findOne({ _id: campaignId, tenantId }).lean();
  if (existing?.broadcastId) {
    return { skipped: true, broadcastId: existing.broadcastId, linkOnly: true };
  }
  if (existing?.scheduledFor && new Date(existing.scheduledFor).getTime() > now.getTime()) {
    return { skipped: true, reason: "NOT_DUE" };
  }
  return { skipped: true };
}

export async function getOrCreatePromotionBroadcast({
  req,
  campaign,
  messageType,
  audienceCount,
}) {
  const sourceKind = broadcastSourceKindForCampaign(campaign);
  const existing = await PushBroadcast.findOne({
    tenantId: campaign.tenantId,
    campaignBusinessKey: campaign.businessKey,
    sourceKind,
  }).lean();
  if (existing) {
    await schedulePushBroadcastFanoutJob(existing._id);
    return existing;
  }
  try {
    const created = await createEcommercePromotionBroadcast({
      req,
      title: campaign.title,
      body: campaign.body,
      deepLink: campaign.deepLink,
      audience: campaign.audience,
      branchId: campaign.branchId,
      customerIds: campaign.customerIds,
      messageType,
      promotionKind: campaign.kind,
      productId: campaign.productId,
      categoryId: campaign.categoryId,
      campaignBusinessKey: campaign.businessKey,
      imageSourceUploadId: campaign.imageUploadId ?? undefined,
      audienceCount,
      sourceKind,
      rateId: campaign.rateId,
      rateSource: campaign.rateSource,
      ratePurity: campaign.purity,
      ratePerGramPaise: campaign.ratePerGramPaise,
      schemeEffectiveDate: campaign.schemeEffectiveDate,
      ecommerceEffectiveAt: campaign.ecommerceEffectiveAt,
    });
    return created;
  } catch (error) {
    if (error?.code === 11000) {
      const raced = await PushBroadcast.findOne({
        tenantId: campaign.tenantId,
        campaignBusinessKey: campaign.businessKey,
      }).lean();
      if (raced) {
        await schedulePushBroadcastFanoutJob(raced._id);
        return raced;
      }
    }
    throw error;
  }
}

export async function aggregateCampaignMessageStats(tenantId, broadcastId) {
  const rows = await Message.aggregate([
    {
      $match: {
        tenantId,
        channel: "PUSH",
        "templateParams.broadcastId": broadcastId,
      },
    },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const byStatus = Object.fromEntries(rows.map((row) => [row._id, row.count]));
  const messagesQueued = Object.values(byStatus).reduce((sum, n) => sum + Number(n), 0);
  const delivered = Number(byStatus[MessageStatus.DELIVERED] ?? 0)
    + Number(byStatus[MessageStatus.READ] ?? 0)
    + Number(byStatus[MessageStatus.SENT] ?? 0);
  const failed = Number(byStatus[MessageStatus.FAILED] ?? 0);
  const pending = Math.max(0, messagesQueued - delivered - failed);
  const allTerminal = messagesQueued > 0 && pending === 0;
  return { messagesQueued, delivered, failed, pending, byStatus, allTerminal };
}

export async function revalidatePromotionBroadcastChunk(broadcast, atMs = Date.now()) {
  if (!broadcast?.campaignBusinessKey) return { ok: true };
  const campaign = await EcommercePromotionCampaign.findOne({
    tenantId: broadcast.tenantId,
    businessKey: broadcast.campaignBusinessKey,
  }).lean();
  if (!campaign) return { ok: true };
  const tenant = await Tenant.findById(broadcast.tenantId).lean();
  if (!tenant) return { ok: false, reason: "TENANT_MISSING" };
  return revalidateCampaignTarget(campaign, tenant, atMs);
}

export async function markPromotionCampaignStoppedForBroadcast(broadcastId, tenantId, reason) {
  const broadcast = await PushBroadcast.findOne({ _id: broadcastId, tenantId }).lean();
  if (!broadcast?.campaignBusinessKey) return;
  await EcommercePromotionCampaign.updateOne(
    {
      tenantId,
      businessKey: broadcast.campaignBusinessKey,
      status: { $in: [EcommercePromotionCampaignStatus.QUEUED, EcommercePromotionCampaignStatus.SENDING] },
      $or: [
        { skippedReason: null },
        { skippedReason: { $exists: false } },
        { skippedReason: { $nin: [...TERMINAL_CANCEL_REASONS] } },
      ],
    },
    {
      $set: {
        status: EcommercePromotionCampaignStatus.CANCELLED,
        skippedReason: reason,
        deliveryLeaseOwner: null,
        deliveryLeaseExpiresAt: null,
        dispatchReconciledAt: null,
      },
    },
  );
}

function dispatchStatsSettled(fanoutDone, msgStats) {
  if (!fanoutDone) return false;
  if (msgStats.messagesQueued === 0) return true;
  return msgStats.allTerminal;
}

function cancelledReasonFilter(campaign) {
  const reason = campaign.skippedReason;
  if (reason == null || reason === "") {
    return {
      $or: [{ skippedReason: null }, { skippedReason: { $exists: false } }, { skippedReason: "" }],
    };
  }
  return { skippedReason: reason };
}

/** Campaigns with outstanding message dispatch accounting (includes stopped/cancelled fanouts). */
export async function listCampaignsForDispatchReconciliation(limit = MAINTENANCE_SCAN_LIMIT) {
  return EcommercePromotionCampaign.find({
    broadcastId: { $ne: null },
    dispatchReconciledAt: null,
    status: {
      $in: [
        EcommercePromotionCampaignStatus.SENDING,
        EcommercePromotionCampaignStatus.CANCELLED,
        EcommercePromotionCampaignStatus.FAILED,
      ],
    },
  })
    .sort({ updatedAt: 1, createdAt: 1 })
    .limit(limit)
    .select("_id tenantId")
    .lean();
}

export async function reconcilePromotionCampaignDispatch(campaignId, tenantId) {
  const campaign = await EcommercePromotionCampaign.findOne({ _id: campaignId, tenantId }).lean();
  if (!campaign?.broadcastId) return { skipped: true, reason: "NO_BROADCAST" };
  if (campaign.dispatchReconciledAt) return { skipped: true, reason: "ALREADY_RECONCILED" };

  const broadcast = await PushBroadcast.findOne({
    _id: campaign.broadcastId,
    tenantId,
  }).lean();
  if (!broadcast) return { skipped: true, reason: "BROADCAST_MISSING" };

  const msgStats = await aggregateCampaignMessageStats(tenantId, broadcast._id);
  const fanoutDone = broadcast.status === JobStatus.COMPLETED || broadcast.status === JobStatus.FAILED;
  const preservedCancel = campaign.status === EcommercePromotionCampaignStatus.CANCELLED;
  const dispatchSettled = dispatchStatsSettled(fanoutDone, msgStats);

  const stats = {
    eligibleCustomers: broadcast.stats?.audienceCount ?? campaign.stats?.eligibleCustomers ?? msgStats.messagesQueued,
    messagesQueued: msgStats.messagesQueued,
    delivered: msgStats.delivered,
    failed: msgStats.failed,
    pending: msgStats.pending,
  };

  const sharedSet = {
    stats,
    deliveryLeaseOwner: null,
    deliveryLeaseExpiresAt: null,
    ...(fanoutDone && !campaign.fanoutCompletedAt
      ? { fanoutCompletedAt: broadcast.completedAt ?? new Date() }
      : {}),
    ...(dispatchSettled ? { dispatchReconciledAt: new Date() } : {}),
  };

  if (preservedCancel) {
    const result = await EcommercePromotionCampaign.updateOne(
      {
        _id: campaignId,
        tenantId,
        status: EcommercePromotionCampaignStatus.CANCELLED,
        ...cancelledReasonFilter(campaign),
        dispatchReconciledAt: null,
      },
      { $set: sharedSet },
    );
    return {
      updated: result.modifiedCount > 0,
      status: EcommercePromotionCampaignStatus.CANCELLED,
      skippedReason: campaign.skippedReason ?? null,
      stats,
      dispatchSettled,
    };
  }

  let nextStatus = EcommercePromotionCampaignStatus.SENDING;
  let skippedReason = campaign.skippedReason ?? null;
  if (fanoutDone && broadcast.status === JobStatus.FAILED) {
    nextStatus = EcommercePromotionCampaignStatus.FAILED;
  } else if (
    fanoutDone
    && broadcast.status === JobStatus.COMPLETED
    && msgStats.messagesQueued === 0
  ) {
    nextStatus = EcommercePromotionCampaignStatus.CANCELLED;
    skippedReason = skippedReason ?? "NO_ELIGIBLE_RECIPIENTS";
  } else if (fanoutDone && msgStats.messagesQueued > 0 && msgStats.allTerminal) {
    nextStatus = msgStats.delivered > 0
      ? EcommercePromotionCampaignStatus.SENT
      : EcommercePromotionCampaignStatus.FAILED;
  }

  const setPayload = {
    ...sharedSet,
    status: nextStatus,
  };
  if (skippedReason) {
    setPayload.skippedReason = skippedReason;
  }

  const result = await EcommercePromotionCampaign.updateOne(
    {
      _id: campaignId,
      tenantId,
      status: { $nin: [EcommercePromotionCampaignStatus.CANCELLED] },
      dispatchReconciledAt: null,
    },
    { $set: setPayload },
  );
  return {
    updated: result.modifiedCount > 0,
    status: nextStatus,
    skippedReason,
    stats,
    dispatchSettled,
  };
}

async function markFanoutStopRecoveryCompletedIfHandoffDone(broadcastId, tenantId) {
  const broadcast = await PushBroadcast.findOne({ _id: broadcastId, tenantId }).lean();
  if (!broadcast) return { marked: false, reason: "NOT_FOUND" };
  if (broadcast.fanoutStopRecoveryCompletedAt) return { marked: false, reason: "ALREADY_MARKED" };
  if (broadcast.campaignBusinessKey) {
    const openCampaign = await EcommercePromotionCampaign.exists({
      tenantId,
      businessKey: broadcast.campaignBusinessKey,
      status: {
        $in: [EcommercePromotionCampaignStatus.QUEUED, EcommercePromotionCampaignStatus.SENDING],
      },
    });
    if (openCampaign) return { marked: false, reason: "CAMPAIGN_STILL_OPEN" };
  }
  const result = await PushBroadcast.updateOne(
    {
      _id: broadcastId,
      tenantId,
      $or: [
        { fanoutStopRecoveryCompletedAt: null },
        { fanoutStopRecoveryCompletedAt: { $exists: false } },
      ],
    },
    { $set: { fanoutStopRecoveryCompletedAt: new Date() } },
  );
  return { marked: result.modifiedCount > 0, reason: result.modifiedCount > 0 ? "OK" : "RACE" };
}

async function completePromotionStopAfterBroadcast(broadcastId, tenantId, reason, { countMetric = false } = {}) {
  await markPromotionCampaignStoppedForBroadcast(broadcastId, tenantId, reason);
  if (countMetric) {
    const { incrementOpsMetric, OpsMetric } = await import("../lib/ops-metrics.js");
    incrementOpsMetric(OpsMetric.BROADCAST_COMPLETED);
  }
  await reconcilePromotionCampaignByBroadcast(broadcastId, tenantId);
  const { kickDeferredPromotionBroadcasts } = await import("./push-broadcast.service.js");
  await kickDeferredPromotionBroadcasts(tenantId);
  await markFanoutStopRecoveryCompletedIfHandoffDone(broadcastId, tenantId);
}

/** Finish campaign cancellation when broadcast already stopped (crash/recovery path). */
export async function recoverIncompletePromotionBroadcastStops(limit = MAINTENANCE_SCAN_LIMIT) {
  const rows = await PushBroadcast.find({
    tenantId: { $exists: true },
    status: JobStatus.COMPLETED,
    fanoutStopReason: { $type: "string" },
    campaignBusinessKey: { $type: "string" },
    $or: [
      { fanoutStopRecoveryCompletedAt: null },
      { fanoutStopRecoveryCompletedAt: { $exists: false } },
    ],
  })
    .sort({ completedAt: 1, updatedAt: 1 })
    .limit(limit)
    .select("_id tenantId fanoutStopReason error campaignBusinessKey")
    .lean();

  let recovered = 0;
  let backfilled = 0;
  for (const broadcast of rows) {
    const reason = broadcast.fanoutStopReason ?? broadcast.error;
    if (!reason) continue;
    const campaign = await EcommercePromotionCampaign.findOne({
      tenantId: broadcast.tenantId,
      businessKey: broadcast.campaignBusinessKey,
      status: { $in: [EcommercePromotionCampaignStatus.QUEUED, EcommercePromotionCampaignStatus.SENDING] },
    }).lean();
    if (!campaign) {
      const mark = await markFanoutStopRecoveryCompletedIfHandoffDone(broadcast._id, broadcast.tenantId);
      if (mark.marked) backfilled += 1;
      continue;
    }
    await completePromotionStopAfterBroadcast(broadcast._id, broadcast.tenantId, reason, {
      countMetric: false,
    });
    recovered += 1;
  }
  return { recovered, backfilled, scanned: rows.length };
}

/**
 * Stop fanout without creating more messages. Requires valid lease ownership for worker-initiated stops.
 * @returns {{ stopped: boolean, stale?: boolean, idempotent?: boolean, reason?: string }}
 */
export async function stopPromotionBroadcastFanout({
  broadcastId,
  tenantId,
  leaseToken,
  reason,
}) {
  if (!leaseToken) {
    return { stopped: false, reason: "LEASE_REQUIRED" };
  }

  const stoppedAt = new Date();
  const broadcastResult = await PushBroadcast.updateOne(
    {
      _id: broadcastId,
      tenantId,
      leaseOwner: leaseToken,
      status: { $in: [JobStatus.QUEUED, JobStatus.PROCESSING] },
    },
    {
      $set: {
        status: JobStatus.COMPLETED,
        completedAt: stoppedAt,
        error: reason,
        fanoutStopReason: reason,
        leaseOwner: null,
        leaseExpiresAt: null,
        fanoutContinuationPending: false,
        fanoutResumeAt: null,
      },
    },
  );

  if (broadcastResult.matchedCount > 0) {
    await completePromotionStopAfterBroadcast(broadcastId, tenantId, reason, { countMetric: true });
    return { stopped: true, reason };
  }

  const row = await PushBroadcast.findOne({ _id: broadcastId, tenantId }).lean();
  if (!row) return { stopped: false, reason: "NOT_FOUND" };

  if (
    row.status === JobStatus.COMPLETED
    && (row.fanoutStopReason === reason || row.error === reason)
  ) {
    await completePromotionStopAfterBroadcast(broadcastId, tenantId, reason, { countMetric: false });
    return { stopped: true, idempotent: true, reason };
  }

  if (row.status === JobStatus.QUEUED || row.status === JobStatus.PROCESSING) {
    return { stopped: false, stale: true, reason: "LEASE_OR_STATE_MISMATCH" };
  }

  return { stopped: false, reason: "ALREADY_TERMINAL" };
}

export async function reconcilePromotionCampaignByBroadcast(broadcastId, tenantId) {
  const broadcast = await PushBroadcast.findOne({ _id: broadcastId, tenantId }).lean();
  if (!broadcast?.campaignBusinessKey) return;
  const campaign = await EcommercePromotionCampaign.findOne({
    tenantId,
    businessKey: broadcast.campaignBusinessKey,
  }).lean();
  if (!campaign) return;
  await reconcilePromotionCampaignDispatch(campaign._id, tenantId);
}

export async function enqueuePromotionCampaignDelivery(campaignId, tenantId, { attempt = 0 } = {}) {
  const queue = getQueue("maintenance");
  if (!queue) {
    logger.warn({ campaignId, tenantId }, "Promotion delivery enqueue skipped — no queue");
    return { enqueued: false, reason: "NO_QUEUE" };
  }
  const jobId = `epcm-deliver-${campaignId}-a${attempt ?? 0}`;
  const result = await ensureRunnableMaintenanceJob(
    queue,
    "ecommerce-promotion-deliver",
    { campaignId, tenantId },
    jobId,
    {
      attempts: 8,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  );
  return {
    enqueued: result.scheduled === true,
    scheduled: result.scheduled === true,
    alreadyPending: result.alreadyPending === true,
    jobId: result.jobId,
    reason: result.reason,
  };
}

export async function deliverPromotionCampaign(campaignId, tenantId) {
  const now = new Date();
  const claim = await claimCampaignForDelivery(campaignId, tenantId, now);
  if (claim.skipped) return claim;
  if (claim.cancelled) return claim;
  if (claim.linkOnly) {
    await reconcilePromotionCampaignDispatch(campaignId, tenantId);
    return claim;
  }

  const { campaign, leaseOwner } = claim;
  try {
    const tenant = await Tenant.findById(tenantId).lean();
    if (!tenant) {
      await markCampaignCancelled(campaignId, tenantId, leaseOwner, "TENANT_MISSING");
      return { cancelled: true, reason: "TENANT_MISSING" };
    }

    const atMs = campaign.scheduledFor
      ? Math.max(Date.now(), new Date(campaign.scheduledFor).getTime())
      : Date.now();
    const validation = await revalidateCampaignTarget(campaign, tenant, atMs);
    if (!validation.ok) {
      await markCampaignCancelled(campaignId, tenantId, leaseOwner, validation.reason);
      return { cancelled: true, reason: validation.reason };
    }

    if (!isRateNotificationKind(campaign.kind) && !isEcommerceOperational(tenant)) {
      await markCampaignCancelled(campaignId, tenantId, leaseOwner, "STORE_INACTIVE");
      return { cancelled: true, reason: "STORE_INACTIVE" };
    }

    const refreshed = await refreshCampaignCopyForDelivery(campaign, tenant, atMs);
    let workingCampaign = refreshed ?? campaign;

    const req = dispatchReqFromCampaign(workingCampaign, tenant);
    if (workingCampaign.kind === EcommercePromotionKind.SCHEME_GOLD_RATE) {
      workingCampaign = {
        ...workingCampaign,
        audience: workingCampaign.branchId ? "BRANCH" : "ALL_DEVICES",
        customerIds: [],
      };
      const broadcastDraft = {
        audience: workingCampaign.audience,
        branchId: workingCampaign.branchId,
        customerIds: [],
      };
      const hasRecipient = await schemeRateHasAnyRecipient({
        tenantId,
        broadcast: broadcastDraft,
        targetRateId: workingCampaign.rateId,
        effectiveDateYmd: workingCampaign.schemeEffectiveDate,
        fetchPage: ({ cursorCustomerId, limit }) =>
          fetchAudienceCustomerPage({
            tenantId,
            broadcast: broadcastDraft,
            cursorCustomerId,
            limit,
          }),
      });
      if (!hasRecipient) {
        await markCampaignCancelled(campaignId, tenantId, leaseOwner, "NO_ELIGIBLE_DEVICES");
        return { cancelled: true, reason: "NO_ELIGIBLE_DEVICES" };
      }
    } else if (workingCampaign.kind === EcommercePromotionKind.ECOMMERCE_GOLD_RATE) {
      workingCampaign = {
        ...workingCampaign,
        audience: "ALL_DEVICES",
        branchId: null,
        customerIds: [],
      };
    }

    const audiencePreview = await countPushAudience(req, {
      audience: workingCampaign.audience,
      branchId: workingCampaign.branchId,
      customerIds: workingCampaign.customerIds,
    });
    if (!audiencePreview.eligibleDevices) {
      await markCampaignCancelled(campaignId, tenantId, leaseOwner, "NO_ELIGIBLE_DEVICES");
      return { cancelled: true, reason: "NO_ELIGIBLE_DEVICES" };
    }

    const messageType = messageTypeForKind(workingCampaign.kind);
    const broadcast = await getOrCreatePromotionBroadcast({
      req,
      campaign: workingCampaign,
      messageType,
      audienceCount: audiencePreview.eligibleDevices,
    });

    const linked = await EcommercePromotionCampaign.findOneAndUpdate(
      {
        _id: campaignId,
        tenantId,
        deliveryLeaseOwner: leaseOwner,
      },
      {
        $set: {
          broadcastId: broadcast._id,
          status: EcommercePromotionCampaignStatus.SENDING,
          title: workingCampaign.title,
          body: workingCampaign.body,
          deepLink: workingCampaign.deepLink,
          deliveryLeaseOwner: null,
          deliveryLeaseExpiresAt: null,
          stats: {
            eligibleCustomers: audiencePreview.eligibleDevices,
            messagesQueued: 0,
            delivered: 0,
            failed: 0,
            pending: 0,
          },
        },
      },
      { new: true },
    ).lean();

    if (!linked) {
      await reconcilePromotionCampaignDispatch(campaignId, tenantId);
      return { broadcastId: broadcast._id, linkageRace: true };
    }

    await reconcilePromotionCampaignDispatch(campaignId, tenantId);
    return { campaign: linked, broadcastId: broadcast._id };
  } catch (error) {
    const terminal = TERMINAL_CANCEL_REASONS.has(error?.code);
    const transient = isTransientInfrastructureError(error);
    if (terminal) {
      await markCampaignCancelled(campaignId, tenantId, leaseOwner, error.code);
      return { cancelled: true, reason: error.code };
    }
    await releaseCampaignDeliveryLease(campaignId, tenantId, leaseOwner, { requeue: true });
    if (!transient && !TERMINAL_CANCEL_REASONS.has(String(error?.code))) {
      logger.error({ err: error, campaignId, tenantId }, "Promotion delivery failed — will retry");
    }
    throw error;
  }
}

export async function recoverStalePromotionCampaigns(now = new Date()) {
  const stale = await EcommercePromotionCampaign.find({
    status: { $in: [EcommercePromotionCampaignStatus.QUEUED, EcommercePromotionCampaignStatus.SENDING] },
    deliveryLeaseExpiresAt: { $lte: now },
    deliveryLeaseOwner: { $ne: null },
  })
    .sort({ deliveryLeaseExpiresAt: 1, createdAt: 1 })
    .limit(MAINTENANCE_SCAN_LIMIT)
    .select("_id tenantId")
    .lean();

  let released = 0;
  for (const row of stale) {
    await EcommercePromotionCampaign.updateOne(
      {
        _id: row._id,
        tenantId: row.tenantId,
        deliveryLeaseOwner: { $ne: null },
        deliveryLeaseExpiresAt: { $lte: now },
      },
      {
        $set: {
          deliveryLeaseOwner: null,
          deliveryLeaseExpiresAt: null,
          status: EcommercePromotionCampaignStatus.QUEUED,
        },
      },
    );
    released += 1;
  }
  return { released };
}

export async function runEcommercePromotionMaintenance(now = new Date()) {
  await recoverStalePromotionCampaigns(now);
  await recoverIncompletePromotionBroadcastStops(MAINTENANCE_SCAN_LIMIT);

  const dispatchReconcile = await listCampaignsForDispatchReconciliation(MAINTENANCE_SCAN_LIMIT);
  for (const row of dispatchReconcile) {
    await reconcilePromotionCampaignDispatch(row._id, row.tenantId);
  }

  const due = await EcommercePromotionCampaign.find({
    status: EcommercePromotionCampaignStatus.QUEUED,
    broadcastId: null,
    $and: [
      { $or: [{ scheduledFor: null }, { scheduledFor: { $lte: now } }] },
      {
        $or: [
          { deliveryLeaseOwner: null },
          { deliveryLeaseExpiresAt: { $lte: now } },
        ],
      },
    ],
  })
    .sort({ scheduledFor: 1, createdAt: 1 })
    .limit(MAINTENANCE_SCAN_LIMIT)
    .select("_id tenantId deliveryAttemptCount")
    .lean();

  let enqueued = 0;
  for (const row of due) {
    const result = await enqueuePromotionCampaignDelivery(row._id, row.tenantId, {
      attempt: row.deliveryAttemptCount ?? 0,
    });
    if (result.enqueued) enqueued += 1;
  }
  return {
    enqueued,
    reconciled: dispatchReconcile.length,
    staleReleased: (await recoverStalePromotionCampaigns(now)).released,
  };
}
