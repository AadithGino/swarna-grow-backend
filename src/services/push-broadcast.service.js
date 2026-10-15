import {
  CustomerStatus,
  DevicePrincipalType,
  DeviceRegistrationStatus,
  JobStatus,
  MessageStatus,
  MessageType,
  PushBroadcastSourceKind,
  UploadPurpose,
} from "../constants/enums.js";
import { env } from "../config/env.js";
import { createId } from "../lib/ids.js";
import { now as calendarNow } from "../lib/date.js";
import { paginate } from "../lib/pagination.js";
import { effectiveScope } from "../lib/query-filters.js";
import { errors } from "../lib/app-error.js";
import { AppError } from "../lib/app-error.js";
import {
  broadcastIdempotencyKey,
  deterministicBroadcastMessageId,
} from "../lib/broadcast-message-id.js";
import { resolveBroadcastPushImage, resolvePromotionPushImage } from "../lib/broadcast-push-image.js";
import { dispatchPriorityForMessageType } from "../lib/message-dispatch-priority.js";
import {
  createSchemeRateApplicabilityCache,
  filterCustomersForSchemeRatePage,
} from "../lib/scheme-rate-fanout-filter.js";
import { ensureRunnableMaintenanceJob } from "../lib/maintenance-queue-job.js";
import {
  buildActiveFanoutRecoveryFilter,
  isFutureFanoutDeferral,
} from "../lib/fanout-recovery.js";
import { incrementOpsMetric, OpsMetric } from "../lib/ops-metrics.js";
import { randomToken } from "../lib/crypto.js";
import {
  Customer,
  DeviceRegistration,
  Message,
  PushBroadcast,
  Tenant,
} from "../models/index.js";
import { getQueue } from "../queues/index.js";
import { writeAudit } from "./audit.service.js";
import { uploadViewPath, validateUploadReferences } from "./upload.service.js";

const ACTIVE_BROADCAST_STATUSES = [JobStatus.QUEUED, JobStatus.PROCESSING];

function chunkSize() {
  return Math.max(50, Math.min(1000, env.PUSH_BROADCAST_CHUNK_SIZE ?? 400));
}

/** Tenant plan cap when set; optional platform cap when PUSH_BROADCAST_MAX_RECIPIENTS > 0. */
async function resolveAudienceCap(tenantId) {
  const tenant = await Tenant.findById(tenantId).select("subscription").lean();
  const planLimit = Number(tenant?.subscription?.limits?.activeCustomers ?? 0);
  const platformCap = Number(env.PUSH_BROADCAST_MAX_RECIPIENTS ?? 0);
  if (planLimit > 0 && platformCap > 0) return Math.min(planLimit, platformCap);
  if (planLimit > 0) return planLimit;
  if (platformCap > 0) return platformCap;
  return null;
}

function audienceCustomerMatchStage(tenantId, broadcast) {
  const match = {
    tenantId,
    status: CustomerStatus.ACTIVE,
  };
  if (broadcast.audience === "BRANCH" && broadcast.branchId) {
    match.branchId = broadcast.branchId;
  }
  if (broadcast.audience === "CUSTOMERS") {
    const ids = [...new Set((broadcast.customerIds ?? []).map(String).filter(Boolean))];
    if (!ids.length) {
      throw new AppError("INVALID_AUDIENCE", "Select at least one customer.", 422);
    }
    match._id = { $in: ids };
  }
  return match;
}

function audienceEligibilityStages(tenantId) {
  return [
    {
      $lookup: {
        from: DeviceRegistration.collection.name,
        let: { customerId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$tenantId", tenantId] },
                  { $eq: ["$principalType", DevicePrincipalType.CUSTOMER] },
                  { $eq: ["$principalId", "$$customerId"] },
                  { $eq: ["$status", DeviceRegistrationStatus.ACTIVE] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: "activeRegistration",
      },
    },
    {
      $match: {
        $or: [
          { "activeRegistration.0": { $exists: true } },
          { "fcmTokens.0": { $exists: true } },
        ],
      },
    },
    { $project: { _id: 1, branchId: 1 } },
  ];
}

/** Keyset page of eligible customers — no unbounded in-memory recipient list. */
export async function fetchAudienceCustomerPage({
  tenantId,
  broadcast,
  cursorCustomerId = null,
  limit,
}) {
  const pageLimit = Math.max(1, limit ?? chunkSize());
  const pipeline = [
    { $match: audienceCustomerMatchStage(tenantId, broadcast) },
    ...audienceEligibilityStages(tenantId),
    ...(cursorCustomerId ? [{ $match: { _id: { $gt: cursorCustomerId } } }] : []),
    { $sort: { _id: 1 } },
    { $limit: pageLimit },
  ];
  return Customer.aggregate(pipeline);
}

async function countAudienceCustomers(tenantId, broadcast) {
  const pipeline = [
    { $match: audienceCustomerMatchStage(tenantId, broadcast) },
    ...audienceEligibilityStages(tenantId),
    { $count: "total" },
  ];
  const rows = await Customer.aggregate(pipeline);
  return rows[0]?.total ?? 0;
}

function toBroadcastDto(row, liveStats) {
  const stats = liveStats ?? row.stats ?? {};
  return {
    id: row._id,
    title: row.title,
    body: row.body,
    deepLink: row.deepLink ?? "/home",
    imageUploadId: row.imageUploadId ?? null,
    imageViewUrl: row.imageUploadId ? uploadViewPath(row.imageUploadId) : null,
    audience: row.audience,
    branchId: row.branchId ?? null,
    customerCount: row.customerIds?.length ?? 0,
    status: row.status,
    stats: {
      audienceCount: stats.audienceCount ?? 0,
      messagesQueued: stats.messagesQueued ?? 0,
      delivered: stats.delivered ?? 0,
      failed: stats.failed ?? 0,
      pending: Math.max(
        0,
        (stats.messagesQueued ?? 0) - (stats.delivered ?? 0) - (stats.failed ?? 0),
      ),
    },
    requestedBy: row.requestedBy,
    error: row.error ?? null,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    createdAt: row.createdAt,
  };
}

async function aggregateDeliveryStats(tenantId, broadcastId) {
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
  const delivered = Number(byStatus.DELIVERED ?? 0)
    + Number(byStatus.READ ?? 0)
    + Number(byStatus.SENT ?? 0);
  const failed = Number(byStatus.FAILED ?? 0);
  const messagesQueued = delivered + failed + Number(byStatus.QUEUED ?? 0);
  return { messagesQueued, delivered, failed };
}

export async function countPushAudience(req, body) {
  const tenantId = req.auth.tenantId;
  const draft = {
    audience: body.audience ?? "ALL_DEVICES",
    branchId: body.branchId ?? req.scope?.branchId ?? null,
    customerIds: body.customerIds ?? [],
  };
  if (draft.audience === "BRANCH" && !draft.branchId) {
    throw new AppError("BRANCH_REQUIRED", "Choose a branch for branch-scoped push.", 422);
  }
  const count = await countAudienceCustomers(tenantId, draft);
  const subscriptionCap = await resolveAudienceCap(tenantId);
  return { eligibleDevices: count, subscriptionCap };
}

export async function createPushBroadcast(req) {
  const title = String(req.body.title ?? "").trim();
  const body = String(req.body.body ?? "").trim();
  const deepLink = String(req.body.deepLink ?? "/home").trim() || "/home";
  const audience = req.body.audience ?? "ALL_DEVICES";
  const branchId =
    audience === "BRANCH"
      ? (req.body.branchId ?? req.scope?.branchId ?? null)
      : null;
  const customerIds = [...new Set((req.body.customerIds ?? []).map(String).filter(Boolean))];
  const imageUploadId = req.body.imageUploadId
    ? String(req.body.imageUploadId).trim()
    : null;

  if (title.length < 2 || title.length > 120) {
    throw new AppError("INVALID_TITLE", "Title must be 2–120 characters.", 422);
  }
  if (body.length < 2 || body.length > 500) {
    throw new AppError("INVALID_BODY", "Message must be 2–500 characters.", 422);
  }
  if (!["ALL_DEVICES", "BRANCH", "CUSTOMERS"].includes(audience)) {
    throw new AppError("INVALID_AUDIENCE", "Unsupported audience.", 422);
  }
  if (audience === "BRANCH" && !branchId) {
    throw new AppError("BRANCH_REQUIRED", "Choose a branch for branch-scoped push.", 422);
  }

  const inFlight = await PushBroadcast.exists({
    tenantId: req.auth.tenantId,
    status: { $in: ACTIVE_BROADCAST_STATUSES },
  });
  if (inFlight) {
    throw errors.business(
      "BROADCAST_IN_PROGRESS",
      "Another push broadcast is still running. Wait for it to finish.",
    );
  }

  const audienceCount = await countAudienceCustomers(
    req.auth.tenantId,
    { audience, branchId, customerIds },
  );
  if (!audienceCount) {
    throw errors.business(
      "NO_PUSH_RECIPIENTS",
      "No customers with a registered app device match this audience.",
    );
  }
  const audienceCap = await resolveAudienceCap(req.auth.tenantId);
  if (audienceCap != null && audienceCount > audienceCap) {
    throw new AppError(
      "AUDIENCE_TOO_LARGE",
      `This audience has ${audienceCount} customers, above your plan limit of ${audienceCap}.`,
      422,
      { audienceCount, subscriptionCap: audienceCap },
    );
  }

  const broadcast = await PushBroadcast.create({
    _id: createId("pbc"),
    tenantId: req.auth.tenantId,
    branchId,
    requestedBy: req.auth.id,
    title,
    body,
    deepLink,
    imageUploadId: imageUploadId ?? undefined,
    audience,
    customerIds,
    status: JobStatus.QUEUED,
    stats: { audienceCount, messagesQueued: 0, delivered: 0, failed: 0 },
  });

  if (imageUploadId) {
    await validateUploadReferences({
      req,
      uploadIds: [imageUploadId],
      purpose: UploadPurpose.PUSH_BROADCAST_IMAGE,
      entityType: "PUSH_BROADCAST",
      entityId: broadcast._id,
    });
  }

  await writeAudit({
    req,
    action: "PUSH_BROADCAST_QUEUED",
    entityType: "MESSAGE",
    entityId: broadcast._id,
    after: broadcast.toObject(),
  });

  const queue = getQueue("maintenance");
  await queue?.add(
    "push-broadcast-fanout",
    { broadcastId: broadcast._id },
    {
      jobId: `${broadcast._id}-fanout`,
      attempts: 8,
      backoff: { type: "exponential", delay: 5000 },
    },
  );

  return toBroadcastDto(broadcast.toObject());
}

export async function listPushBroadcasts(req) {
  const scope = effectiveScope(req);
  const result = await paginate(PushBroadcast, {
    scope: { tenantId: scope.tenantId },
    filters: {},
    cursor: req.query.cursor,
    limit: req.query.limit,
    sort: "createdAt:desc",
  });
  const ids = result.data.map((row) => row._id);
  const statsRows = ids.length
    ? await Message.aggregate([
      {
        $match: {
          tenantId: scope.tenantId,
          channel: "PUSH",
          type: MessageType.MANUAL_PUSH,
          "templateParams.broadcastId": { $in: ids },
        },
      },
      {
        $group: {
          _id: { broadcastId: "$templateParams.broadcastId", status: "$status" },
          count: { $sum: 1 },
        },
      },
    ])
    : [];
  const statsByBroadcast = new Map();
  for (const row of statsRows) {
    const broadcastId = row._id.broadcastId;
    if (!statsByBroadcast.has(broadcastId)) statsByBroadcast.set(broadcastId, {});
    statsByBroadcast.get(broadcastId)[row._id.status] = row.count;
  }
  result.data = result.data.map((row) => {
    const byStatus = statsByBroadcast.get(row._id) ?? {};
    const delivered = Number(byStatus.DELIVERED ?? 0)
      + Number(byStatus.READ ?? 0)
      + Number(byStatus.SENT ?? 0);
    const failed = Number(byStatus.FAILED ?? 0);
    const messagesQueued = delivered + failed + Number(byStatus.QUEUED ?? 0);
    return toBroadcastDto(row, {
      ...row.stats,
      messagesQueued,
      delivered,
      failed,
      audienceCount: row.stats?.audienceCount,
    });
  });
  return result;
}

export async function getPushBroadcast(req) {
  const row = await PushBroadcast.findOne({
    _id: req.params.broadcastId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!row) throw errors.notFound("Push broadcast");
  const live = await aggregateDeliveryStats(row.tenantId, row._id);
  return toBroadcastDto(row, { ...row.stats, ...live, audienceCount: row.stats?.audienceCount });
}

function leaseMs() {
  return env.PUSH_BROADCAST_LEASE_MS ?? 120_000;
}

function buildBroadcastLeaseToken(broadcastId) {
  return `pbclease_${broadcastId}_${randomToken(10)}`;
}

async function acquireBroadcastLease(broadcastId, tenantId) {
  const leaseToken = buildBroadcastLeaseToken(broadcastId);
  const now = new Date();
  const broadcast = await PushBroadcast.findOneAndUpdate(
    {
      _id: broadcastId,
      tenantId,
      status: { $in: ACTIVE_BROADCAST_STATUSES },
      $or: [
        { leaseExpiresAt: { $lte: now } },
        { leaseExpiresAt: null },
        { leaseExpiresAt: { $exists: false } },
      ],
    },
    {
      $set: {
        leaseOwner: leaseToken,
        leaseExpiresAt: new Date(now.getTime() + leaseMs()),
        status: JobStatus.PROCESSING,
      },
    },
    { new: true },
  );
  return broadcast ? { broadcast, leaseToken } : null;
}

/** Owner-safe lease release after a fan-out page completes or fails. */
export async function clearBroadcastLease({ broadcastId, tenantId, leaseToken }) {
  if (!leaseToken) return { modifiedCount: 0 };
  return PushBroadcast.updateOne(
    { _id: broadcastId, tenantId, leaseOwner: leaseToken },
    { $unset: { leaseOwner: "", leaseExpiresAt: "" } },
  );
}

export { buildActiveFanoutRecoveryFilter };

function resumeNotBlockingFutureFilter(now) {
  return {
    $or: [
      { fanoutResumeAt: null },
      { fanoutResumeAt: { $exists: false } },
      { fanoutResumeAt: { $lte: now } },
    ],
  };
}

/** Bounded scan: re-enqueue deterministic continuation jobs for unfinished broadcasts. */
export async function recoverActivePushBroadcastFanouts({ limit = 25 } = {}) {
  const now = calendarNow().toDate();
  const rows = await PushBroadcast.find(buildActiveFanoutRecoveryFilter(now))
    .sort({ updatedAt: 1 })
    .limit(Math.max(1, limit))
    .lean();
  let enqueued = 0;
  let delayed = 0;
  for (const row of rows) {
    const outcome = await enqueueFanoutRecoveryForBroadcast(row, now);
    if (outcome.mode === "delayed") delayed += 1;
    else enqueued += 1;
  }
  return { scanned: rows.length, enqueued, delayed };
}

export async function processPushBroadcastFanoutRecovery() {
  return recoverActivePushBroadcastFanouts({ limit: 25 });
}

/** @deprecated Use recoverActivePushBroadcastFanouts via maintenance job. */
export async function recoverStalePushBroadcastFanout(broadcastId) {
  const now = calendarNow().toDate();
  const row = await PushBroadcast.findOne({
    _id: broadcastId,
    ...buildActiveFanoutRecoveryFilter(now),
  }).lean();
  if (!row) return false;
  await enqueueFanoutRecoveryForBroadcast(row, now);
  return true;
}

async function releaseLeaseThenScheduleContinuation({
  broadcastId,
  tenantId,
  leaseToken,
  cursorCustomerId,
}) {
  await clearBroadcastLease({ broadcastId, tenantId, leaseToken });
  await scheduleNextFanoutChunk(broadcastId, cursorCustomerId);
  await PushBroadcast.updateOne(
    {
      _id: broadcastId,
      tenantId,
      status: { $in: ACTIVE_BROADCAST_STATUSES },
      fanoutContinuationPending: true,
    },
    { $set: { fanoutContinuationPending: false } },
  );
}

function templateParamsForCustomer(broadcast, customer) {
  const campaignKey = broadcast.campaignBusinessKey ?? broadcast._id;
  const params = {
    broadcastId: broadcast._id,
    title: broadcast.title,
    body: broadcast.body,
    deepLink: broadcast.deepLink,
    inboxEventKey: `${campaignKey}:${customer._id}`,
    productId: broadcast.productId ?? "",
    categoryId: broadcast.categoryId ?? "",
    promotionKind: broadcast.promotionKind ?? "",
    campaignBusinessKey: campaignKey,
    rateId: broadcast.rateId ?? "",
    rateSource: broadcast.rateSource ?? "",
    purity: broadcast.ratePurity ?? "",
    ratePerGramPaise: broadcast.ratePerGramPaise != null ? String(broadcast.ratePerGramPaise) : "",
    schemeEffectiveDate: broadcast.schemeEffectiveDate ?? "",
    effectiveAt: broadcast.ecommerceEffectiveAt
      ? new Date(broadcast.ecommerceEffectiveAt).toISOString()
      : "",
    branchId: broadcast.branchId ?? "",
  };
  if (
    broadcast.pushImageUrl
    && broadcast.pushImageUrlValidUntil
    && new Date(broadcast.pushImageUrlValidUntil) > new Date()
  ) {
    params.pushImageUrl = broadcast.pushImageUrl;
  }
  return params;
}

export function buildBroadcastChunkWrites({ broadcast, customers }) {
  const messageOps = [];
  const messageIds = [];
  const messageType = broadcast.messageType ?? MessageType.MANUAL_PUSH;
  for (const customer of customers) {
    const messageId = deterministicBroadcastMessageId(
      broadcast.tenantId,
      broadcast._id,
      customer._id,
    );
    const idempotencyKey = broadcastIdempotencyKey(
      broadcast.tenantId,
      broadcast._id,
      customer._id,
    );
    messageIds.push(messageId);
    messageOps.push({
      updateOne: {
        filter: { _id: messageId },
        update: {
          $setOnInsert: {
            _id: messageId,
            tenantId: broadcast.tenantId,
            branchId: customer.branchId ?? broadcast.branchId ?? null,
            customerId: customer._id,
            type: messageType,
            status: MessageStatus.QUEUED,
            channel: "PUSH",
            templateKey: messageType,
            templateParams: templateParamsForCustomer(broadcast, customer),
            dispatchPriority: dispatchPriorityForMessageType(messageType),
            broadcastIdempotencyKey: idempotencyKey,
          },
        },
        upsert: true,
      },
    });
  }
  return { messageOps, outboxOps: [], messageIds };
}

/** Ecommerce marketing broadcast — queues behind an in-flight tenant broadcast instead of failing. */
export async function createEcommercePromotionBroadcast({
  req,
  title,
  body,
  deepLink,
  audience,
  branchId,
  customerIds,
  messageType,
  promotionKind,
  productId,
  categoryId,
  campaignBusinessKey,
  imageSourceUploadId,
  audienceCount,
  sourceKind = PushBroadcastSourceKind.ECOMMERCE_PROMOTION,
  rateId,
  rateSource,
  ratePurity,
  ratePerGramPaise,
  schemeEffectiveDate,
  ecommerceEffectiveAt,
}) {
  const tenantId = req.auth.tenantId;
  const inFlight = await PushBroadcast.exists({
    tenantId,
    status: { $in: ACTIVE_BROADCAST_STATUSES },
  });

  const broadcast = await PushBroadcast.create({
    _id: createId("pbc"),
    tenantId,
    branchId: audience === "BRANCH" ? branchId : null,
    requestedBy: req.auth.id,
    title,
    body,
    deepLink,
    audience,
    customerIds,
    messageType,
    sourceKind,
    productId: productId ?? undefined,
    categoryId: categoryId ?? undefined,
    campaignBusinessKey,
    promotionKind,
    rateId: rateId ?? undefined,
    rateSource: rateSource ?? undefined,
    ratePurity: ratePurity ?? undefined,
    ratePerGramPaise: ratePerGramPaise ?? undefined,
    schemeEffectiveDate: schemeEffectiveDate ?? undefined,
    ecommerceEffectiveAt: ecommerceEffectiveAt ?? undefined,
    imageSourceUploadId: imageSourceUploadId ?? undefined,
    fanoutContinuationPending: Boolean(inFlight),
    status: JobStatus.QUEUED,
    stats: {
      audienceCount: audienceCount ?? 0,
      messagesQueued: 0,
      delivered: 0,
      failed: 0,
    },
  });

  await writeAudit({
    req,
    action: "ECOMMERCE_PROMOTION_BROADCAST_QUEUED",
    entityType: "MESSAGE",
    entityId: broadcast._id,
    after: broadcast.toObject(),
  });

  if (!inFlight) {
    const queue = getQueue("maintenance");
    await queue?.add(
      "push-broadcast-fanout",
      { broadcastId: broadcast._id },
      {
        jobId: `${broadcast._id}-fanout`,
        attempts: 8,
        backoff: { type: "exponential", delay: 5000 },
      },
    );
  }
  return broadcast.toObject();
}

async function scheduleNextFanoutChunk(broadcastId, cursorCustomerId, { delayMs = 0, jobId: jobIdOverride } = {}) {
  const queue = getQueue("maintenance");
  const jobId = jobIdOverride ?? `${broadcastId}-fanout-${cursorCustomerId ?? "start"}`;
  return ensureRunnableMaintenanceJob(
    queue,
    "push-broadcast-fanout",
    { broadcastId },
    jobId,
    {
      ...(delayMs > 0 ? { delay: delayMs } : {}),
      attempts: 8,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  );
}

/** Enqueue (or reuse) a delayed NOT_DUE continuation at the persisted due instant. */
export async function enqueueDelayedFanoutContinuation({ broadcastId, resumeAt, businessYmd }) {
  const delayMs = Math.max(0, resumeAt.getTime() - calendarNow().valueOf());
  const { fanoutDueJobId } = await import("../lib/fanout-not-due-schedule.js");
  const jobId = fanoutDueJobId(broadcastId, resumeAt, businessYmd);
  const result = await scheduleNextFanoutChunk(broadcastId, null, {
    delayMs,
    jobId,
  });
  return { ...result, delayMs, jobId, resumeAt, mode: "delayed" };
}

async function enqueueFanoutRecoveryForBroadcast(row, now = new Date()) {
  if (isFutureFanoutDeferral(row, now)) {
    return enqueueDelayedFanoutContinuation({
      broadcastId: row._id,
      resumeAt: new Date(row.fanoutResumeAt),
      businessYmd: row.schemeEffectiveDate ?? undefined,
    });
  }
  await scheduleNextFanoutChunk(row._id, row.cursorCustomerId ?? null);
  return { mode: "immediate" };
}

/** Persist NOT_DUE deferral and enqueue a delayed continuation at the authoritative due instant. */
export async function scheduleFanoutContinuationAt({
  broadcastId,
  tenantId,
  leaseToken,
  resumeAt,
  businessYmd,
}) {
  if (!leaseToken) {
    return { deferred: false, stale: true, reason: "LEASE_REQUIRED" };
  }
  const deferResult = await PushBroadcast.updateOne(
    {
      _id: broadcastId,
      tenantId,
      leaseOwner: leaseToken,
      status: { $in: ACTIVE_BROADCAST_STATUSES },
    },
    {
      $set: {
        fanoutResumeAt: resumeAt,
        fanoutContinuationPending: true,
      },
      $unset: { leaseOwner: "", leaseExpiresAt: "" },
    },
  );
  if (deferResult.matchedCount === 0) {
    return { deferred: false, stale: true, reason: "LEASE_OR_STATE_MISMATCH" };
  }
  const enqueue = await enqueueDelayedFanoutContinuation({ broadcastId, resumeAt, businessYmd });
  return { deferred: true, stale: false, ...enqueue };
}

/** Ensure fan-out is queued when reusing an idempotent ecommerce promotion broadcast. */
export async function schedulePushBroadcastFanoutJob(broadcastId) {
  const row = await PushBroadcast.findById(broadcastId).lean();
  if (!row || row.status === JobStatus.COMPLETED || row.status === JobStatus.FAILED) return;
  const now = calendarNow().toDate();
  if (isFutureFanoutDeferral(row, now)) {
    await enqueueDelayedFanoutContinuation({
      broadcastId,
      resumeAt: new Date(row.fanoutResumeAt),
      businessYmd: row.schemeEffectiveDate ?? undefined,
    });
    return;
  }
  await scheduleNextFanoutChunk(broadcastId, row.cursorCustomerId ?? null);
}

/**
 * Enqueue a push broadcast using the same path as admin create (for staging runners).
 * @internal
 */
export async function enqueuePushBroadcastInternal({
  tenantId,
  requestedBy,
  title,
  body,
  deepLink = "/home",
  audience = "ALL_DEVICES",
  branchId = null,
  customerIds = [],
  audienceCount,
}) {
  const inFlight = await PushBroadcast.exists({
    tenantId,
    status: { $in: ACTIVE_BROADCAST_STATUSES },
  });
  if (inFlight) {
    throw errors.business(
      "BROADCAST_IN_PROGRESS",
      "Another push broadcast is still running.",
    );
  }
  const count = audienceCount ?? await countAudienceCustomers(tenantId, {
    audience,
    branchId,
    customerIds,
  });
  const broadcast = await PushBroadcast.create({
    _id: createId("pbc"),
    tenantId,
    branchId: audience === "BRANCH" ? branchId : null,
    requestedBy,
    title,
    body,
    deepLink,
    audience,
    customerIds,
    status: JobStatus.QUEUED,
    stats: { audienceCount: count, messagesQueued: 0, delivered: 0, failed: 0 },
  });
  const queue = getQueue("maintenance");
  await queue?.add(
    "push-broadcast-fanout",
    { broadcastId: broadcast._id },
    {
      jobId: `${broadcast._id}-fanout`,
      attempts: 8,
      backoff: { type: "exponential", delay: 5000 },
    },
  );
  return broadcast;
}

/** Fan-out one chunk; re-queue job if more customers remain. */
export async function processPushBroadcastFanout(broadcastId, _workerLabel = randomToken(6)) {
  const pre = await PushBroadcast.findById(broadcastId).lean();
  if (!pre || pre.status === JobStatus.COMPLETED || pre.status === JobStatus.FAILED) {
    return;
  }

  const acquired = await acquireBroadcastLease(broadcastId, pre.tenantId);
  if (!acquired) return;

  let broadcast = acquired.broadcast;
  const leaseToken = acquired.leaseToken;
  const tenantId = broadcast.tenantId;
  const expectedCursor = broadcast.cursorCustomerId ?? null;
  let leaseReleasedEarly = false;

  try {
    if (broadcast.cursorCustomerId) {
      incrementOpsMetric(OpsMetric.BROADCAST_RESUMED);
    } else {
      incrementOpsMetric(OpsMetric.FCM_CAMPAIGN_STARTED);
    }

    if (!broadcast.startedAt) {
      await PushBroadcast.updateOne(
        { _id: broadcastId, tenantId, leaseOwner: leaseToken },
        { $set: { startedAt: new Date() } },
      );
      broadcast.startedAt = new Date();
    }
    const imageId = broadcast.imageSourceUploadId ?? broadcast.imageUploadId;
    if (imageId && !broadcast.pushImageUrl && !broadcast.pushImageUrlValidUntil) {
      const resolved = broadcast.sourceKind === PushBroadcastSourceKind.ECOMMERCE_PROMOTION
        || broadcast.sourceKind === PushBroadcastSourceKind.GOLD_RATE_NOTIFICATION
        ? await resolvePromotionPushImage(imageId, { tenantId })
        : await resolveBroadcastPushImage(imageId);
      await PushBroadcast.updateOne(
        { _id: broadcastId, tenantId, leaseOwner: leaseToken },
        {
          $set: {
            pushImageUrl: resolved.imageUrl ?? undefined,
            pushImageUrlValidUntil: resolved.validUntil ?? undefined,
          },
        },
      );
      broadcast.pushImageUrl = resolved.imageUrl ?? undefined;
      broadcast.pushImageUrlValidUntil = resolved.validUntil ?? undefined;
    }

    const {
      revalidatePromotionBroadcastChunk,
      stopPromotionBroadcastFanout,
    } = await import("./ecommerce-promotion-delivery.service.js");
    const chunkValidation = await revalidatePromotionBroadcastChunk(broadcast.toObject());
    if (chunkValidation.ok && broadcast.fanoutResumeAt) {
      await PushBroadcast.updateOne(
        {
          _id: broadcastId,
          tenantId,
          leaseOwner: leaseToken,
          status: { $in: ACTIVE_BROADCAST_STATUSES },
          fanoutResumeAt: { $lte: calendarNow().toDate() },
        },
        {
          $unset: { fanoutResumeAt: "" },
          $set: { fanoutContinuationPending: false },
        },
      );
      broadcast.fanoutResumeAt = undefined;
      broadcast.fanoutContinuationPending = false;
    }
    if (!chunkValidation.ok) {
      if (chunkValidation.reason === "NOT_DUE") {
        const { resolveFanoutNotDueResumeAt } = await import("../lib/fanout-not-due-schedule.js");
        const resumeAt = resolveFanoutNotDueResumeAt(broadcast.toObject());
        if (resumeAt) {
          const deferResult = await scheduleFanoutContinuationAt({
            broadcastId,
            tenantId,
            leaseToken,
            resumeAt,
            businessYmd: broadcast.schemeEffectiveDate ?? undefined,
          });
          if (deferResult.deferred || deferResult.stale) {
            leaseReleasedEarly = deferResult.deferred;
          }
          return;
        }
        await clearBroadcastLease({ broadcastId, tenantId, leaseToken });
        leaseReleasedEarly = true;
        return;
      }
      const stopResult = await stopPromotionBroadcastFanout({
        broadcastId,
        tenantId,
        leaseToken,
        reason: chunkValidation.reason,
      });
      if (stopResult.stopped) {
        leaseReleasedEarly = true;
      }
      return;
    }

    const customers = await fetchAudienceCustomerPage({
      tenantId,
      broadcast: broadcast.toObject(),
      cursorCustomerId: expectedCursor,
      limit: chunkSize(),
    });

    let deliverCustomers = customers;
    if (
      broadcast.rateId
      && broadcast.schemeEffectiveDate
      && broadcast.messageType === MessageType.SCHEME_GOLD_RATE_UPDATED
    ) {
      const cache = createSchemeRateApplicabilityCache();
      deliverCustomers = await filterCustomersForSchemeRatePage({
        tenantId,
        customers,
        targetRateId: broadcast.rateId,
        effectiveDateYmd: broadcast.schemeEffectiveDate,
        cache,
      });
    }

    if (!customers.length) {
      await PushBroadcast.updateOne(
        {
          _id: broadcastId,
          tenantId,
          leaseOwner: leaseToken,
          status: { $in: ACTIVE_BROADCAST_STATUSES },
        },
        {
          $set: {
            status: JobStatus.COMPLETED,
            completedAt: new Date(),
          },
        },
      );
      const live = await aggregateDeliveryStats(tenantId, broadcastId);
      await PushBroadcast.updateOne(
        { _id: broadcastId, tenantId, status: JobStatus.COMPLETED },
        { $set: { stats: { ...broadcast.stats?.toObject?.() ?? broadcast.stats, ...live } } },
      );
      incrementOpsMetric(OpsMetric.BROADCAST_COMPLETED);
      incrementOpsMetric(OpsMetric.FCM_CAMPAIGN_COMPLETED);
      await kickDeferredPromotionBroadcasts(tenantId);
      const { reconcilePromotionCampaignByBroadcast } = await import("./ecommerce-promotion-delivery.service.js");
      await reconcilePromotionCampaignByBroadcast(broadcastId, tenantId);
      return;
    }

    const { messageOps } = buildBroadcastChunkWrites({
      broadcast: broadcast.toObject(),
      customers: deliverCustomers,
    });
    let upsertedMessages = 0;
    if (messageOps.length) {
      const writeResult = await Message.bulkWrite(messageOps, { ordered: false });
      upsertedMessages = writeResult.upsertedCount ?? 0;
    }
    incrementOpsMetric(OpsMetric.BROADCAST_FANOUT_CHUNK);

    const newCursor = customers[customers.length - 1]._id;
    const hasMore = customers.length >= chunkSize();
    const cursorUpdated = await PushBroadcast.findOneAndUpdate(
      {
        _id: broadcastId,
        tenantId,
        cursorCustomerId: expectedCursor,
        leaseOwner: leaseToken,
        status: { $in: ACTIVE_BROADCAST_STATUSES },
      },
      {
        $set: {
          cursorCustomerId: newCursor,
          ...(hasMore ? { fanoutContinuationPending: true } : {}),
        },
        ...(upsertedMessages ? { $inc: { "stats.messagesQueued": upsertedMessages } } : {}),
      },
      { new: true },
    );
    if (!cursorUpdated) {
      throw new Error("BROADCAST_CURSOR_CONFLICT");
    }

    if (hasMore) {
      await releaseLeaseThenScheduleContinuation({
        broadcastId,
        tenantId,
        leaseToken,
        cursorCustomerId: newCursor,
      });
      leaseReleasedEarly = true;
    } else {
      await PushBroadcast.updateOne(
        {
          _id: broadcastId,
          tenantId,
          leaseOwner: leaseToken,
          status: { $in: ACTIVE_BROADCAST_STATUSES },
        },
        {
          $set: {
            status: JobStatus.COMPLETED,
            completedAt: new Date(),
          },
        },
      );
      incrementOpsMetric(OpsMetric.BROADCAST_COMPLETED);
      incrementOpsMetric(OpsMetric.FCM_CAMPAIGN_COMPLETED);
      await kickDeferredPromotionBroadcasts(tenantId);
      const { reconcilePromotionCampaignByBroadcast } = await import("./ecommerce-promotion-delivery.service.js");
      await reconcilePromotionCampaignByBroadcast(broadcastId, tenantId);
    }
  } catch (error) {
    const attempts = (broadcast.chunkAttempts ?? 0) + 1;
    const maxAttempts = env.PUSH_BROADCAST_MAX_CHUNK_ATTEMPTS ?? 12;
    const terminal = attempts >= maxAttempts;
    await PushBroadcast.updateOne(
      {
        _id: broadcastId,
        tenantId,
        leaseOwner: leaseToken,
        status: { $in: ACTIVE_BROADCAST_STATUSES },
      },
      {
        $set: {
          chunkAttempts: attempts,
          error: error.message,
          ...(terminal
            ? { status: JobStatus.FAILED, completedAt: new Date() }
            : {}),
        },
      },
    );
    if (terminal) {
      incrementOpsMetric(OpsMetric.BROADCAST_FAILED);
      const { reconcilePromotionCampaignByBroadcast } = await import("./ecommerce-promotion-delivery.service.js");
      await reconcilePromotionCampaignByBroadcast(broadcastId, tenantId);
    } else {
      const current = await PushBroadcast.findOne({
        _id: broadcastId,
        tenantId,
        leaseOwner: leaseToken,
        status: { $in: ACTIVE_BROADCAST_STATUSES },
      }).lean();
      if (current) {
        await PushBroadcast.updateOne(
          {
            _id: broadcastId,
            tenantId,
            leaseOwner: leaseToken,
            status: { $in: ACTIVE_BROADCAST_STATUSES },
          },
          { $set: { fanoutContinuationPending: true } },
        );
        await clearBroadcastLease({ broadcastId, tenantId, leaseToken });
        leaseReleasedEarly = true;
        await scheduleNextFanoutChunk(broadcastId, current.cursorCustomerId ?? null);
        await PushBroadcast.updateOne(
          {
            _id: broadcastId,
            tenantId,
            status: { $in: ACTIVE_BROADCAST_STATUSES },
            fanoutContinuationPending: true,
          },
          { $set: { fanoutContinuationPending: false } },
        );
      }
    }
    throw error;
  } finally {
    if (!leaseReleasedEarly) {
      await clearBroadcastLease({ broadcastId, tenantId, leaseToken });
    }
  }
}

export async function kickDeferredPromotionBroadcasts(tenantId) {
  const now = calendarNow().toDate();
  const pending = await PushBroadcast.findOne({
    tenantId,
    sourceKind: {
      $in: [
        PushBroadcastSourceKind.ECOMMERCE_PROMOTION,
        PushBroadcastSourceKind.GOLD_RATE_NOTIFICATION,
      ],
    },
    fanoutContinuationPending: true,
    status: JobStatus.QUEUED,
    ...resumeNotBlockingFutureFilter(now),
  })
    .sort({ createdAt: 1 })
    .lean();
  if (!pending) return;
  await PushBroadcast.updateOne(
    { _id: pending._id, tenantId },
    { $set: { fanoutContinuationPending: false } },
  );
  const queue = getQueue("maintenance");
  await queue?.add(
    "push-broadcast-fanout",
    { broadcastId: pending._id },
    {
      jobId: `${pending._id}-fanout-deferred`,
      attempts: 8,
      backoff: { type: "exponential", delay: 5000 },
    },
  );
}
