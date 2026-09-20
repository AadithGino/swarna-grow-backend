/**
 * Staging / load helper for push fan-out verification.
 *
 * Mock:  npm run load:fcm-15k-mock
 * Live:  node --env-file=.env scripts/fcm-staging-15k.js --dry-run=false --confirm-live-staging --tenant-id=tnt_x
 */
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { redactStagingReport } from "../src/lib/fcm-staging-verdict.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseStagingArg(name, fallback) {
  const eqPrefix = `--${name}=`;
  const hit = process.argv.find((row) => row.startsWith(eqPrefix));
  if (hit) {
    const raw = hit.slice(eqPrefix.length);
    if (raw === "true") return true;
    if (raw === "false") return false;
    const num = Number(raw);
    return Number.isFinite(num) ? num : raw;
  }
  if (process.argv.includes(`--${name}`) && typeof fallback === "boolean") {
    return true;
  }
  return fallback;
}

const dryRun = parseStagingArg("dry-run", true);
const confirmLive = parseStagingArg("confirm-live-staging", false);
const tenantId = parseStagingArg("tenant-id", "");
const recipients = parseStagingArg("recipients", 15_000);
const timeoutMs = parseStagingArg("timeout-ms", 3_600_000);

function exitReport(report, code) {
  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(redactStagingReport(report)));
  process.exit(code);
}

const report = {
  mode: dryRun ? "MOCK_DRY_RUN" : "LIVE_STAGING",
  requestedUniqueCustomers: recipients,
  startedAt: new Date().toISOString(),
};

if (dryRun) {
  const load = spawnSync(
    process.execPath,
    ["scripts/production-load-hardening.js", `--broadcast-recipients=${recipients}`, `--customers=${recipients}`],
    { encoding: "utf8", cwd: root },
  );
  report.loadHardeningExitCode = load.status;
  try {
    report.loadHardening = JSON.parse(load.stdout);
  } catch {
    report.loadHardeningStdout = load.stdout?.slice(0, 4000);
    report.loadHardeningStderr = load.stderr?.slice(0, 2000);
  }
  exitReport(report, load.status === 0 ? 0 : 1);
}

if (process.env.NODE_ENV === "production") {
  report.error = "LIVE_STAGING_REFUSED_PRODUCTION";
  exitReport(report, 1);
}
if (!confirmLive) {
  report.error = "LIVE_STAGING_REQUIRES_CONFIRM_FLAG";
  exitReport(report, 1);
}
if (!tenantId) {
  report.error = "LIVE_STAGING_REQUIRES_TENANT_ID";
  exitReport(report, 1);
}

try {
  const { env } = await import("../src/config/env.js");
  const { connectDatabase, disconnectDatabase } = await import("../src/config/database.js");
  const { connectRedis, disconnectRedis, redisReady } = await import("../src/config/redis.js");
  const { isStagingFcmDeviceId } = await import("../src/lib/fcm-staging.js");
  const { resolveFcmConfigForTenant } = await import("../src/lib/fcm-config.js");
  const { getQueueHealthSnapshot } = await import("../src/lib/queue-health.js");
  const { workerProcessReady } = await import("../src/lib/worker-heartbeat.js");
  const {
    DeviceRegistration,
    PushBroadcast,
    Message,
    PushDeviceDelivery,
    Tenant,
  } = await import("../src/models/index.js");
  const { DevicePrincipalType, DeviceRegistrationStatus, JobStatus } = await import("../src/constants/enums.js");
  const { PushDeviceDeliveryStatus } = await import("../src/constants/enums.js");
  const { enqueuePushBroadcastInternal } = await import("../src/services/push-broadcast.service.js");
  const { effectiveFcmSendChunkSize } = await import("../src/lib/fcm-quota-chunk.js");
  const {
    diffSharedFcmMetrics,
    getSharedFcmMetricsSnapshot,
  } = await import("../src/lib/fcm-redis-metrics.js");
  const {
    aggregateDeliveryStatusRows,
    evaluateStagingCampaignVerdict,
  } = await import("../src/lib/fcm-staging-verdict.js");
  await connectDatabase();
  const replica = mongoose.connection.db.admin().command({ replSetGetStatus: 1 }).catch(() => null);
  if (!replica?.ok) {
    report.error = "MONGO_REPLICA_SET_REQUIRED";
    await disconnectDatabase();
    exitReport(report, 1);
  }
  const redisOk = await connectRedis();
  if (!redisOk || !redisReady()) {
    report.error = "REDIS_REQUIRED";
    await disconnectDatabase();
    exitReport(report, 1);
  }

  const tenant = await Tenant.findById(tenantId).select("+integrationSecrets").lean();
  if (!tenant) {
    report.error = "TENANT_NOT_FOUND";
    await disconnectRedis().catch(() => {});
    await disconnectDatabase();
    exitReport(report, 1);
  }
  const fcmConfig = resolveFcmConfigForTenant(tenant);
  if (!fcmConfig) {
    report.error = "FCM_NOT_CONFIGURED";
    await disconnectRedis().catch(() => {});
    await disconnectDatabase();
    exitReport(report, 1);
  }

  const registrations = await DeviceRegistration.find({
    tenantId,
    principalType: DevicePrincipalType.CUSTOMER,
    status: DeviceRegistrationStatus.ACTIVE,
  }).select("deviceId principalId").lean();
  const stagingRegs = registrations.filter((row) => isStagingFcmDeviceId(row.deviceId));
  const nonStaging = registrations.length - stagingRegs.length;
  const uniqueSyntheticCustomers = new Set(stagingRegs.map((row) => row.principalId));
  report.discoveredUniqueSyntheticCustomers = uniqueSyntheticCustomers.size;
  report.discoveredStagingDevices = stagingRegs.length;
  report.nonStagingDevices = nonStaging;

  if (nonStaging > 0) {
    report.error = "INVALID_STAGING_AUDIENCE_NON_SYNTHETIC";
    await disconnectRedis().catch(() => {});
    await disconnectDatabase();
    exitReport(report, 1);
  }
  if (uniqueSyntheticCustomers.size !== recipients) {
    report.error = "STAGING_CUSTOMER_COUNT_MISMATCH";
    await disconnectRedis().catch(() => {});
    await disconnectDatabase();
    exitReport(report, 1);
  }

  const queues = await getQueueHealthSnapshot().catch(() => null);
  if (!queues?.available) {
    report.error = "QUEUE_HEALTH_UNAVAILABLE";
    await disconnectRedis().catch(() => {});
    await disconnectDatabase();
    exitReport(report, 1);
  }
  const workersOk = await workerProcessReady();
  if (!workersOk) {
    report.error = "WORKERS_NOT_HEALTHY";
    report.queueSnapshot = queues;
    await disconnectRedis().catch(() => {});
    await disconnectDatabase();
    exitReport(report, 1);
  }
  for (const required of ["maintenance", "messages", "outbox"]) {
    if (!queues.queues[required] || queues.queues[required].error) {
      report.error = "REQUIRED_QUEUE_UNAVAILABLE";
      report.missingQueue = required;
      await disconnectRedis().catch(() => {});
      await disconnectDatabase();
      exitReport(report, 1);
    }
  }

  const activeBroadcast = await PushBroadcast.exists({
    tenantId,
    status: { $in: [JobStatus.QUEUED, JobStatus.PROCESSING] },
  });
  if (activeBroadcast) {
    report.error = "BROADCAST_IN_PROGRESS";
    await disconnectRedis().catch(() => {});
    await disconnectDatabase();
    exitReport(report, 1);
  }

  let sharedMetricsBefore;
  try {
    sharedMetricsBefore = await getSharedFcmMetricsSnapshot();
  } catch {
    report.error = "FCM_SHARED_METRICS_UNAVAILABLE";
    await disconnectRedis().catch(() => {});
    await disconnectDatabase();
    exitReport(report, 1);
  }

  const eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
  eventLoopHistogram.enable();

  report.campaignId = null;
  report.resolvedTenantId = tenantId;
  report.maxSendChunk = effectiveFcmSendChunkSize();
  report.maxPageSize = env.PUSH_BROADCAST_CHUNK_SIZE ?? 400;
  console.log(JSON.stringify({
    phase: "preflight_ok",
    tenantId,
    requestedUniqueCustomers: recipients,
    mode: "LIVE_STAGING",
  }));

  const memBefore = process.memoryUsage().heapUsed;
  let memPeak = memBefore;
  const started = performance.now();
  const broadcast = await enqueuePushBroadcastInternal({
    tenantId,
    requestedBy: "staging-runner",
    title: "Staging synthetic push",
    body: "Staging FCM fan-out verification",
    deepLink: "/home",
    audience: "ALL_DEVICES",
    audienceCount: recipients,
  });
  report.campaignId = broadcast._id;

  const deadline = Date.now() + timeoutMs;
  const lagSamples = [];
  let pagesProcessed = 0;
  let lastMessagesQueued = 0;
  let unhealthyPollStreak = 0;
  const unhealthyPollLimit = 3;

  while (Date.now() < deadline) {
    memPeak = Math.max(memPeak, process.memoryUsage().heapUsed);
    const row = await PushBroadcast.findById(broadcast._id).lean();
    if (!row) {
      report.error = "CAMPAIGN_MISSING";
      break;
    }
    if (row.stats?.messagesQueued > lastMessagesQueued) {
      pagesProcessed += 1;
      lastMessagesQueued = row.stats.messagesQueued;
    }
    const queueSnap = await getQueueHealthSnapshot().catch(() => null);
    if (queueSnap?.oldestMessageQueuedMs != null) lagSamples.push(queueSnap.oldestMessageQueuedMs);
    const workersHealthy = await workerProcessReady();
    if (!workersHealthy) {
      unhealthyPollStreak += 1;
      if (unhealthyPollStreak >= unhealthyPollLimit) {
        report.error = "WORKERS_UNHEALTHY_DURING_RUN";
        break;
      }
    } else {
      unhealthyPollStreak = 0;
    }

    const fanoutComplete = row.status === JobStatus.COMPLETED || row.status === JobStatus.FAILED;
    const messageCount = await Message.countDocuments({
      tenantId,
      "templateParams.broadcastId": broadcast._id,
    });
    const campaignMessageIds = await Message.find({
      tenantId,
      "templateParams.broadcastId": broadcast._id,
    }).select("_id").lean();
    const deliveryAgg = campaignMessageIds.length
      ? await PushDeviceDelivery.aggregate([
        { $match: { tenantId, messageId: { $in: campaignMessageIds.map((row) => row._id) } } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ])
      : [];
    const now = new Date();
    const campaignMessageIdList = campaignMessageIds.map((r) => r._id);
    const activeProcessing = campaignMessageIdList.length
      ? await PushDeviceDelivery.countDocuments({
        tenantId,
        messageId: { $in: campaignMessageIdList },
        status: PushDeviceDeliveryStatus.PROCESSING,
        claimExpiresAt: { $gt: now },
      })
      : 0;

    if (fanoutComplete && messageCount === recipients) {
      const agg = aggregateDeliveryStatusRows(deliveryAgg);
      const allSucceeded = agg.succeeded === stagingRegs.length
        && agg.queued === 0
        && agg.retryableFailed === 0
        && agg.permanentFailed === 0
        && agg.deadLetter === 0
        && agg.processing === 0
        && activeProcessing === 0;
      if (allSucceeded || row.status === JobStatus.FAILED) break;
    }
    if (row.status === JobStatus.FAILED) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  const finalBroadcast = await PushBroadcast.findById(broadcast._id).lean();
  const logicalMessages = await Message.countDocuments({
    tenantId,
    "templateParams.broadcastId": broadcast._id,
  });
  const messageIds = await Message.find({
    tenantId,
    "templateParams.broadcastId": broadcast._id,
  }).select("_id customerId").lean();
  const uniqueCustomersInMessages = new Set(messageIds.map((row) => row.customerId));
  const deliveryRows = await PushDeviceDelivery.aggregate([
    {
      $match: {
        tenantId,
        messageId: { $in: messageIds.map((row) => row._id) },
      },
    },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const deliveryByStatus = Object.fromEntries(deliveryRows.map((row) => [row._id, row.count]));
  const deliveryAggFinal = aggregateDeliveryStatusRows(deliveryRows);
  let sharedMetricsAfter;
  try {
    sharedMetricsAfter = await getSharedFcmMetricsSnapshot();
  } catch {
    report.error = "FCM_SHARED_METRICS_UNAVAILABLE";
    sharedMetricsAfter = { counters: {} };
  }
  eventLoopHistogram.disable();
  const durationMs = Math.round(performance.now() - started);

  lagSamples.sort((a, b) => a - b);
  const percentile = (p) => {
    if (!lagSamples.length) return 0;
    const idx = Math.min(lagSamples.length - 1, Math.floor((p / 100) * lagSamples.length));
    return lagSamples[idx];
  };

  report.pagesProcessed = pagesProcessed;
  report.logicalMessagesCreated = logicalMessages;
  report.duplicateLogicalMessages = logicalMessages - uniqueCustomersInMessages.size;
  report.missingLogicalMessages = Math.max(0, recipients - uniqueCustomersInMessages.size);
  report.queueLagP50Ms = percentile(50);
  report.queueLagP95Ms = percentile(95);
  report.queueLagP99Ms = percentile(99);
  report.totalCompletionMs = durationMs;
  report.succeededDeliveries = deliveryByStatus[PushDeviceDeliveryStatus.SUCCEEDED] ?? 0;
  report.retryableDeliveries = deliveryByStatus[PushDeviceDeliveryStatus.RETRYABLE_FAILED] ?? 0;
  report.permanentFailedDeliveries = deliveryByStatus[PushDeviceDeliveryStatus.PERMANENT_FAILED] ?? 0;
  report.deadLetterDeliveries = deliveryByStatus[PushDeviceDeliveryStatus.DEAD_LETTER] ?? 0;
  report.activeProcessingDeliveries = deliveryByStatus[PushDeviceDeliveryStatus.PROCESSING] ?? 0;
  report.sharedFcmMetricsDelta = diffSharedFcmMetrics(sharedMetricsBefore, sharedMetricsAfter);
  report.eventLoopLagMs = {
    mean: Math.round(eventLoopHistogram.mean / 1e6),
    p95: Math.round(eventLoopHistogram.percentile(95) / 1e6),
    p99: Math.round(eventLoopHistogram.percentile(99) / 1e6),
    max: Math.round(eventLoopHistogram.max / 1e6),
  };
  report.heapBeforeMb = Math.round(memBefore / 1024 / 1024);
  report.heapPeakMb = Math.round(memPeak / 1024 / 1024);
  report.heapAfterMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  report.finalCampaignStatus = finalBroadcast?.status;
  report.finalDeliveryStatus = {
    succeeded: report.succeededDeliveries,
    retryable: report.retryableDeliveries,
    permanentFailed: report.permanentFailedDeliveries,
    deadLetter: report.deadLetterDeliveries,
    activeProcessing: report.activeProcessingDeliveries,
  };

  if (Date.now() >= deadline) report.error = report.error ?? "CAMPAIGN_TIMEOUT";

  const verdict = evaluateStagingCampaignVerdict({
    requestedUniqueCustomers: recipients,
    discoveredUniqueCustomers: uniqueSyntheticCustomers.size,
    logicalMessages,
    duplicateLogicalMessages: report.duplicateLogicalMessages,
    missingLogicalMessages: report.missingLogicalMessages,
    campaignStatus: finalBroadcast?.status ?? "UNKNOWN",
    deliveries: {
      expectedDevices: stagingRegs.length,
      totalRows: messageIds.length ? await PushDeviceDelivery.countDocuments({
        tenantId,
        messageId: { $in: messageIds.map((row) => row._id) },
      }) : 0,
      missingDeliveryRows: Math.max(0, stagingRegs.length - (report.succeededDeliveries
        + report.retryableDeliveries + report.permanentFailedDeliveries
        + report.deadLetterDeliveries + report.activeProcessingDeliveries
        + (deliveryByStatus[PushDeviceDeliveryStatus.QUEUED] ?? 0))),
      queued: deliveryAggFinal.queued,
      processingActive: report.activeProcessingDeliveries,
      processingExpired: 0,
      retryableFailed: deliveryAggFinal.retryableFailed,
      succeeded: deliveryAggFinal.succeeded,
      permanentFailed: deliveryAggFinal.permanentFailed,
      deadLetter: deliveryAggFinal.deadLetter,
    },
  });
  if (!verdict.ok) report.error = report.error ?? verdict.errors[0];
  report.verdictErrors = verdict.errors;

  await disconnectRedis().catch(() => {});
  await disconnectDatabase();
  exitReport(report, verdict.exitCode || report.error ? 1 : 0);
} catch (error) {
  report.error = error.message?.slice(0, 300) ?? "LIVE_STAGING_FAILED";
  exitReport(report, 1);
}
