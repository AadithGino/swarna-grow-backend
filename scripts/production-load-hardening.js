/**
 * Opt-in synthetic load / scale sanity (no live FCM/PhonePe charges).
 *
 * Usage:
 *   npm run load:hardening
 *   npm run load:hardening -- --customers=15000 --broadcast-recipients=15000
 *
 * With MongoDB + Redis (.env): also samples queue health and broadcast chunk writes.
 */
import { performance } from "node:perf_hooks";
import { buildReminderDedupeKey } from "../src/lib/reminder-dedupe.js";
import { buildBroadcastChunkWrites } from "../src/services/push-broadcast.service.js";
import { selectFairMessageBatch } from "../src/lib/fair-message-dispatch.js";

function parseArg(name, fallback) {
  const hit = process.argv.find((row) => row.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return Number(hit.split("=")[1]);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const customers = parseArg("customers", 15_000);
const broadcastRecipients = parseArg("broadcast-recipients", 15_000);
const smallTenants = parseArg("small-tenants", 5);
const tenantId = "tnt_load_synth";

const report = {
  startedAt: new Date().toISOString(),
  config: { customers, broadcastRecipients, smallTenants },
  phases: {},
};

function timed(name, fn) {
  const t0 = performance.now();
  const result = fn();
  const ms = Math.round(performance.now() - t0);
  report.phases[name] = { durationMs: ms, ...(typeof result === "object" ? result : { result }) };
}

timed("reminder_dedupe_keys", () => {
  const keys = new Set();
  for (let i = 0; i < customers; i += 1) {
    keys.add(
      buildReminderDedupeKey({
        tenantId,
        schemeId: `sch_${i}`,
        messageType: "PAYMENT_DUE",
        channel: "PUSH",
        offsetKey: "D_DAY",
        reminderDate: "2026-09-18",
        installmentNumber: i % 12,
      }),
    );
  }
  return { uniqueKeys: keys.size };
});

timed("broadcast_15k_keyset_fanout", () => {
  const pageSize = 400;
  const ids = Array.from({ length: broadcastRecipients }, (_, i) => `cus_${String(i).padStart(6, "0")}`);
  const broadcast = {
    _id: "bc_load",
    tenantId,
    branchId: null,
    title: "Load",
    body: "Synthetic",
    deepLink: null,
    pushImageUrl: null,
    pushImageUrlValidUntil: null,
    imageUploadId: null,
  };
  let cursor = null;
  let pages = 0;
  let maxPage = 0;
  let peakOutstandingJobs = 1;
  let messageOpsTotal = 0;
  const seen = new Set();
  const memBefore = process.memoryUsage().heapUsed;
  let memPeak = memBefore;
  while (true) {
    const pageIds = ids.filter((id) => !cursor || id > cursor).slice(0, pageSize);
    if (!pageIds.length) break;
    pages += 1;
    maxPage = Math.max(maxPage, pageIds.length);
    peakOutstandingJobs = Math.max(peakOutstandingJobs, 1);
    const customerRows = pageIds.map((_id) => ({ _id, branchId: "br_hq" }));
    const { messageOps } = buildBroadcastChunkWrites({ broadcast, customers: customerRows });
    messageOpsTotal += messageOps.length;
    for (const id of pageIds) seen.add(id);
    cursor = pageIds[pageIds.length - 1];
    memPeak = Math.max(memPeak, process.memoryUsage().heapUsed);
    if (pageIds.length < pageSize) break;
  }
  const memAfter = process.memoryUsage().heapUsed;
  return {
    mode: "MOCK_DRY_RUN",
    totalRecipients: broadcastRecipients,
    uniqueRecipients: seen.size,
    duplicates: messageOpsTotal - seen.size,
    missingRecipients: broadcastRecipients - seen.size,
    maxPageSize: maxPage,
    maxFcmBatchSize: 500,
    pages,
    peakOutstandingJobs,
    messageOpsTotal,
    heapBeforeMb: Math.round(memBefore / 1024 / 1024),
    heapPeakMb: Math.round(memPeak / 1024 / 1024),
    heapAfterMb: Math.round(memAfter / 1024 / 1024),
  };
});

timed("dispatcher_fairness", () => {
  const latencies = [];
  const rows = [];
  for (let t = 0; t < smallTenants; t += 1) {
    for (let i = 0; i < 500; i += 1) {
      rows.push({
        tenantId: `tnt_small_${t}`,
        dispatchPriority: 50,
        createdAt: new Date(Date.now() - i * 1000),
        _id: `msg_${t}_${i}`,
      });
    }
  }
  for (let i = 0; i < customers; i += 1) {
    rows.push({
      tenantId,
      dispatchPriority: 10,
      createdAt: new Date(Date.now() - i * 10),
      _id: `msg_big_${i}`,
    });
  }
  const t0 = performance.now();
  const batch = selectFairMessageBatch(rows, { global: 200, perTenant: 40 });
  latencies.push(Math.round(performance.now() - t0));
  const byTenant = {};
  for (const row of batch) byTenant[row.tenantId] = (byTenant[row.tenantId] ?? 0) + 1;
  return {
    batchSize: batch.length,
    tenantsInBatch: Object.keys(byTenant).length,
    largestTenantShare: Math.max(...Object.values(byTenant)),
    p50Ms: percentile(latencies, 50),
  };
});

if (process.env.MONGODB_URI) {
  try {
    const { connectDatabase, disconnectDatabase } = await import("../src/config/database.js");
    const { connectRedis, disconnectRedis } = await import("../src/config/redis.js");
    await connectDatabase();
    await connectRedis().catch(() => {});
    const { getQueueHealthSnapshot, evaluateQueueHealth } = await import("../src/lib/queue-health.js");
    const t0 = performance.now();
    const queues = await getQueueHealthSnapshot();
    report.phases.live_queue_health = {
      durationMs: Math.round(performance.now() - t0),
      evaluation: evaluateQueueHealth(queues),
      oldestMessageQueuedMs: queues.oldestMessageQueuedMs,
    };
    await disconnectRedis().catch(() => {});
    await disconnectDatabase();
  } catch (error) {
    report.phases.live_queue_health = { error: error.message?.slice(0, 200) };
  }
}

report.finishedAt = new Date().toISOString();
report.totalDurationMs = Object.values(report.phases).reduce(
  (sum, row) => sum + (row.durationMs ?? 0),
  0,
);
report.note =
  "MOCK/DRY-RUN evidence only (no live FCM). For production capacity claims, run the real staging gate: seeded Mongo replica set + Redis + BullMQ workers + FCM test devices.";
report.stagingGateCommands = [
  "npm run seed:demo",
  "npm run worker",
  "npm run scheduler",
  "node --env-file=.env scripts/fcm-staging-15k.js --dry-run=false",
  "npm run ops:inspect",
];

console.log(JSON.stringify(report, null, 2));
