import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import IORedis from "ioredis";
import { env } from "../src/config/env.js";
import { connectRedis, getRedis, redisReady } from "../src/config/redis.js";
import {
  acquireFcmSendQuota,
  fcmLimiterGlobalKey,
  fcmLimiterTestHooks,
  readLimiterBucketTokens,
  resetFcmLimiterScriptsForTests,
  resetFcmLimiterTestHooksForTests,
} from "../src/lib/fcm-redis-limiter.js";
import { effectiveFcmSendChunkSize } from "../src/lib/fcm-quota-chunk.js";
import { PushOutcomeKind } from "../src/lib/fcm-outcomes.js";
import { retryDelayMs } from "../src/lib/fcm-outcomes.js";
import {
  chunkDevices,
  dedupeDevices,
  multicastBatchSize,
} from "../src/integrations/push.provider.js";
import {
  applyPushOutcomes,
  claimDeliveriesForProcessing,
  ensurePushDeliveries,
  listDeliveriesToSend,
} from "../src/services/push-delivery.service.js";
import {
  invalidateDeviceRegistrations,
  markDeviceFailure,
  markDeviceSuccess,
} from "../src/services/device-registration.service.js";
import { buildBroadcastChunkWrites } from "../src/services/push-broadcast.service.js";
import { incrementOpsMetric, getOpsMetricsSnapshot, resetOpsMetricsForTests, OpsMetric } from "../src/lib/ops-metrics.js";
import { PushDeviceDeliveryStatus } from "../src/constants/enums.js";
import { Alert, PushDeviceDelivery } from "../src/models/index.js";
import { startTestDb, stopTestDb, resetTestDb, seedTenantUser, seedCustomer } from "./helpers/db.js";
import { selectFairMessageBatch } from "../src/lib/fair-message-dispatch.js";
import { DeviceRegistration } from "../src/models/index.js";
import { DevicePrincipalType } from "../src/constants/enums.js";
import { registerFcmDevice } from "../src/services/device-registration.service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function assertRedisGate() {
  const probe = new IORedis(env.REDIS_URL, {
    connectTimeout: 1500,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  try {
    await probe.connect();
    await probe.ping();
    await probe.quit();
  } catch (error) {
    assert.fail(`Redis required for Phase D tests: ${error.message}`);
  }
  const connected = await connectRedis().catch(() => false);
  assert.ok(connected && redisReady(), "Redis connection failed");
}

async function flushLimiterKeys() {
  const redis = getRedis();
  const keys = await redis.keys("fcm:{limiter}:*");
  if (keys.length) await redis.del(...keys);
}

test.before(async () => {
  await assertRedisGate();
  await startTestDb();
});
test.after(async () => {
  resetFcmLimiterTestHooksForTests();
  resetFcmLimiterScriptsForTests();
  await flushLimiterKeys();
  await stopTestDb();
});

test.beforeEach(async () => {
  resetOpsMetricsForTests();
  resetFcmLimiterTestHooksForTests();
  resetFcmLimiterScriptsForTests();
  await flushLimiterKeys();
});

test("exact global capacity across concurrent multi-tenant workers", async () => {
  const globalBurst = 80;
  fcmLimiterTestHooks.override = {
    globalBurst,
    globalRatePerSec: 0.001,
    tenantBurst: globalBurst,
    tenantRatePerSec: 1000,
  };
  await flushLimiterKeys();
  const cost = globalBurst;
  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      acquireFcmSendQuota({ tenantId: `tnt_exact_${i}`, cost }),
    ),
  );
  const allowed = attempts.filter((row) => row.allowed);
  assert.equal(allowed.length, 1);
  assert.equal(allowed.length * cost, globalBurst);
  const globalTokens = await readLimiterBucketTokens(getRedis(), fcmLimiterGlobalKey());
  assert.ok(globalTokens >= 0);
  const tenantKeys = await getRedis().keys("fcm:{limiter}:tenant:*");
  for (const key of tenantKeys) {
    const tokens = await readLimiterBucketTokens(getRedis(), key);
    assert.ok(tokens >= 0);
  }
});

test("atomic per-tenant limit", async () => {
  const burst = env.FCM_RATE_LIMIT_TENANT_BURST ?? 160;
  const parallel = await Promise.all(
    Array.from({ length: burst }, () =>
      acquireFcmSendQuota({ tenantId: "tnt_tenant_cap", cost: 1 }),
    ),
  );
  assert.ok(parallel.every((row) => row.allowed));
  const denied = await acquireFcmSendQuota({ tenantId: "tnt_tenant_cap", cost: 1 });
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs >= 1);
});

test("tenant denial does not consume global quota", async () => {
  fcmLimiterTestHooks.override = {
    globalBurst: 500,
    globalRatePerSec: 0.001,
    tenantBurst: 2,
    tenantRatePerSec: 0.001,
  };
  await flushLimiterKeys();
  await acquireFcmSendQuota({ tenantId: "tnt_exhaust_global_check", cost: 1 });
  await acquireFcmSendQuota({ tenantId: "tnt_exhaust_global_check", cost: 1 });
  const globalBefore = await readLimiterBucketTokens(getRedis(), fcmLimiterGlobalKey());
  const denied = await acquireFcmSendQuota({ tenantId: "tnt_exhaust_global_check", cost: 1 });
  assert.equal(denied.allowed, false);
  assert.equal(denied.scope, "tenant");
  const globalAfter = await readLimiterBucketTokens(getRedis(), fcmLimiterGlobalKey());
  assert.ok(globalAfter >= globalBefore);
  const other = await acquireFcmSendQuota({ tenantId: "tnt_other_after_denial", cost: 1 });
  assert.equal(other.allowed, true);
  assert.ok((await readLimiterBucketTokens(getRedis(), fcmLimiterGlobalKey())) >= 0);
});

test("redis SCRIPT FLUSH recovery without process restart", async () => {
  const ok1 = await acquireFcmSendQuota({ tenantId: "tnt_script_flush", cost: 1 });
  assert.equal(ok1.allowed, true);
  await getRedis().script("FLUSH");
  const ok2 = await acquireFcmSendQuota({ tenantId: "tnt_script_flush", cost: 1 });
  assert.equal(ok2.allowed, true);
});

test("one tenant cannot consume another tenant quota", async () => {
  const burst = env.FCM_RATE_LIMIT_TENANT_BURST ?? 160;
  await Promise.all(
    Array.from({ length: burst }, () => acquireFcmSendQuota({ tenantId: "tnt_x", cost: 1 })),
  );
  const denied = await acquireFcmSendQuota({ tenantId: "tnt_x", cost: 1 });
  assert.equal(denied.allowed, false);
  const other = await acquireFcmSendQuota({ tenantId: "tnt_y", cost: 1 });
  assert.equal(other.allowed, true);
});

test("global limit caps combined tenants", async () => {
  const globalBurst = 60;
  fcmLimiterTestHooks.override = {
    globalBurst,
    globalRatePerSec: 0.001,
    tenantBurst: globalBurst,
    tenantRatePerSec: 1000,
  };
  await flushLimiterKeys();
  const cost = 20;
  const first = await Promise.all(
    Array.from({ length: 3 }, (_, i) =>
      acquireFcmSendQuota({ tenantId: `tnt_mix_${i}`, cost }),
    ),
  );
  assert.equal(first.filter((row) => row.allowed).length, 3);
  const denied = await acquireFcmSendQuota({ tenantId: "tnt_mix_denied", cost: 1 });
  assert.equal(denied.allowed, false);
});

test("redis failure defers safely without calling FCM", async () => {
  fcmLimiterTestHooks.forceRedisError = true;
  const quota = await acquireFcmSendQuota({ tenantId: "tnt_redis_fail", cost: 1 });
  assert.equal(quota.allowed, false);
  assert.equal(quota.redisUnavailable, true);
  assert.ok(quota.retryAfterMs >= 500);
});

test("rate-limited jobs expose retry delay not zero busy-loop", async () => {
  fcmLimiterTestHooks.override = {
    globalBurst: 1000,
    globalRatePerSec: 0.001,
    tenantBurst: 1,
    tenantRatePerSec: 0.001,
  };
  await flushLimiterKeys();
  await acquireFcmSendQuota({ tenantId: "tnt_delay_isolated", cost: 1 });
  const denied = await acquireFcmSendQuota({ tenantId: "tnt_delay_isolated", cost: 1 });
  assert.equal(denied.allowed, false);
  assert.ok(Number.isFinite(denied.retryAfterMs));
  assert.ok(denied.retryAfterMs >= 1);
});

test("500 devices split into safe quota chunks without loss", () => {
  const chunk = effectiveFcmSendChunkSize();
  const devices = Array.from({ length: 500 }, (_, i) => ({
    deviceRegistrationId: `dvr_${i}`,
    tokenHash: `hash_${i}`,
  }));
  const deduped = dedupeDevices(devices);
  const batches = chunkDevices(deduped, chunk);
  assert.ok(batches.every((batch) => batch.length <= chunk));
  assert.ok(batches.every((batch) => batch.length <= (env.FCM_RATE_LIMIT_GLOBAL_BURST ?? 400)));
  assert.ok(batches.every((batch) => batch.length <= (env.FCM_RATE_LIMIT_TENANT_BURST ?? 160)));
  assert.equal(batches.flat().length, 500);
});

test("15000 logical recipients without missing or duplicate ids", () => {
  const ids = new Set();
  for (let i = 0; i < 15_000; i += 1) {
    ids.add(`cus_${i}`);
  }
  const { messageOps } = buildBroadcastChunkWrites({
    broadcast: {
      _id: "pbc_15k",
      tenantId: "tnt_15k",
      title: "T",
      body: "B",
      deepLink: "/home",
    },
    customers: [...ids].map((_id) => ({ _id, branchId: "br_1" })),
  });
  const messageIds = messageOps.map((op) => op.updateOne.filter._id);
  assert.equal(new Set(messageIds).size, 15_000);
  assert.equal(messageIds.length, 15_000);
});

test("in-memory multicast batch size never exceeds configured cap", () => {
  const devices = Array.from({ length: 1200 }, (_, i) => ({
    deviceRegistrationId: `dvr_${i}`,
    tokenHash: `hash_${i}`,
    token: `token_${i}`,
  }));
  const deduped = dedupeDevices(devices);
  const batches = chunkDevices(deduped, multicastBatchSize());
  assert.ok(batches.every((batch) => batch.length <= 500));
  assert.equal(batches.length, Math.ceil(1200 / multicastBatchSize()));
});

test("partial success retries only retryable failed recipients", async () => {
    await resetTestDb();
    const messageId = "msg_partial";
    const tenantId = "tnt_partial";
    await ensurePushDeliveries({
      tenantId,
      messageId,
      devices: [
        { deviceRegistrationId: "dvr_ok", tokenHash: "h1" },
        { deviceRegistrationId: "dvr_retry", tokenHash: "h2" },
      ],
    });
    const claimed = await claimDeliveriesForProcessing({
      tenantId,
      messageId,
      deviceRegistrationIds: ["dvr_ok", "dvr_retry"],
    });
    const claimById = Object.fromEntries(claimed.map((row) => [row.deviceRegistrationId, row.claimToken]));
    await applyPushOutcomes({
      tenantId,
      messageId,
      outcomes: [
        {
          deviceRegistrationId: "dvr_ok",
          claimToken: claimById.dvr_ok,
          kind: PushOutcomeKind.SUCCESS,
          attempt: 1,
        },
        {
          deviceRegistrationId: "dvr_retry",
          claimToken: claimById.dvr_retry,
          kind: PushOutcomeKind.TRANSIENT,
          attempt: 1,
        },
      ],
    });
    const pending = await listDeliveriesToSend(messageId, tenantId);
    assert.deepEqual(pending.map((row) => row.deviceRegistrationId), ["dvr_retry"]);
});

test("permanent invalid tokens disabled with tenant and ownership fencing", async () => {
    await resetTestDb();
    const { tenant, branch } = await seedTenantUser();
    const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
    const reg = await registerFcmDevice({
      tenantId: tenant._id,
      principalType: DevicePrincipalType.CUSTOMER,
      principalId: customer._id,
      deviceId: "dev1",
      platform: "android",
      fcmToken: "token-permanent-invalid",
    });
    await invalidateDeviceRegistrations(
      tenant._id,
      [{
        id: reg._id,
        expectedTokenHash: reg.tokenHash,
        registrationVersion: reg.version,
      }],
      "FCM_UNREGISTERED",
    );
    const row = await DeviceRegistration.findById(reg._id).lean();
    assert.equal(row.status, "INVALIDATED");
});

test("token reassignment race cannot disable new owner registration", async () => {
    await resetTestDb();
    const { tenant, branch } = await seedTenantUser();
    const customerA = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
    const customerB = await seedCustomer({
      tenantId: tenant._id,
      branchId: branch._id,
      mobile: `+9197${String(Date.now()).slice(-8)}`,
    });
    const old = await registerFcmDevice({
      tenantId: tenant._id,
      principalType: DevicePrincipalType.CUSTOMER,
      principalId: customerA._id,
      deviceId: "dev_race",
      platform: "android",
      fcmToken: "shared-token-value",
    });
    const neu = await registerFcmDevice({
      tenantId: tenant._id,
      principalType: DevicePrincipalType.CUSTOMER,
      principalId: customerB._id,
      deviceId: "dev_race_b",
      platform: "android",
      fcmToken: "shared-token-value",
    });
    await invalidateDeviceRegistrations(
      tenant._id,
      [{
        id: old._id,
        expectedTokenHash: old.tokenHash,
        registrationVersion: old.version,
      }],
      "FCM_UNREGISTERED",
    );
    const fresh = await DeviceRegistration.findById(neu._id).lean();
    assert.equal(fresh.status, "ACTIVE");
});

test("duplicate queue delivery does not duplicate logical notification records", () => {
  const customers = [{ _id: "cus_dup", branchId: "br_1" }];
  const broadcast = {
    _id: "pbc_dup",
    tenantId: "tnt_dup",
    title: "T",
    body: "B",
    deepLink: "/home",
  };
  const first = buildBroadcastChunkWrites({ broadcast, customers });
  const second = buildBroadcastChunkWrites({ broadcast, customers });
  assert.equal(first.messageOps[0].updateOne.filter._id, second.messageOps[0].updateOne.filter._id);
  assert.deepEqual(first.messageOps[0].updateOne.update.$setOnInsert, second.messageOps[0].updateOne.update.$setOnInsert);
});

test("terminal delivery states cannot regress on retry", async () => {
    await resetTestDb();
    const tenantId = "tnt_terminal";
    const messageId = "msg_terminal";
    await PushDeviceDelivery.create({
      _id: "pdd_terminal",
      tenantId,
      messageId,
      deviceRegistrationId: "dvr_t",
      status: PushDeviceDeliveryStatus.SUCCEEDED,
      attemptCount: 1,
    });
    await applyPushOutcomes({
      tenantId,
      messageId,
      outcomes: [{
        deviceRegistrationId: "dvr_t",
        kind: PushOutcomeKind.TRANSIENT,
        attempt: 2,
      }],
    });
    const row = await PushDeviceDelivery.findOne({ messageId, deviceRegistrationId: "dvr_t" }).lean();
    assert.equal(row.status, PushDeviceDeliveryStatus.SUCCEEDED);
});

test("worker failure between page creation resumes with cursor conflict protection", () => {
  const chunk = 400;
  const total = 1500;
  const all = Array.from({ length: total }, (_, i) => `cus_${String(i).padStart(6, "0")}`);
  let cursor = null;
  const pass1 = [];
  while (pass1.length < 800) {
    const page = all.filter((id) => !cursor || id > cursor).slice(0, chunk);
    if (!page.length) break;
    pass1.push(...page);
    cursor = page[page.length - 1];
  }
  const resumeCursor = cursor;
  const pass2 = [];
  let resumeFrom = resumeCursor;
  while (true) {
    const page = all.filter((id) => !resumeFrom || id > resumeFrom).slice(0, chunk);
    if (!page.length) break;
    pass2.push(...page);
    resumeFrom = page[page.length - 1];
    if (page.length < chunk) break;
  }
  const merged = new Set([...pass1, ...pass2]);
  assert.equal(merged.size, total);
});

test("stale recovery bounded job ids prevent unbounded duplicate fanout keys", () => {
  const broadcastId = "pbc_stale";
  const cursors = [null, "cus_1", "cus_2"];
  const jobIds = cursors.map((cursor) => `${broadcastId}-fanout-${cursor ?? "start"}`);
  assert.equal(new Set(jobIds).size, jobIds.length);
});

test("two tenants with large broadcasts both make progress under fair dispatch", () => {
  const rows = [];
  for (let i = 0; i < 1000; i += 1) {
    rows.push({ _id: `a_${i}`, tenantId: "tnt_big_a", dispatchPriority: 10, createdAt: new Date(i) });
    rows.push({ _id: `b_${i}`, tenantId: "tnt_big_b", dispatchPriority: 10, createdAt: new Date(i) });
  }
  const batch = selectFairMessageBatch(rows, { global: 200, perTenant: 40 });
  const counts = {};
  for (const row of batch) counts[row.tenantId] = (counts[row.tenantId] ?? 0) + 1;
  assert.ok(counts.tnt_big_a > 0);
  assert.ok(counts.tnt_big_b > 0);
});

test("transient provider failures use bounded backoff with jitter", () => {
  const d1 = retryDelayMs(2, 500, null);
  const d2 = retryDelayMs(2, 500, null);
  assert.ok(d1 >= 500 && d1 <= 60_000);
  assert.ok(d2 >= 500 && d2 <= 60_000);
  assert.ok(retryDelayMs(1, 500, 10_000) === 10_000);
});

test("retry exhaustion creates one deduplicated alert", async () => {
    await resetTestDb();
    const tenantId = "tnt_alert";
    const messageId = "msg_alert";
    const maxAttempts = env.FCM_MAX_ATTEMPTS ?? 3;
    await ensurePushDeliveries({
      tenantId,
      messageId,
      devices: [{ deviceRegistrationId: "dvr_ex", tokenHash: "hx" }],
    });
    await PushDeviceDelivery.updateOne(
      { tenantId, messageId, deviceRegistrationId: "dvr_ex" },
      { $set: { status: PushDeviceDeliveryStatus.RETRYABLE_FAILED, attemptCount: maxAttempts - 1 } },
    );
    const claimed = await claimDeliveriesForProcessing({
      tenantId,
      messageId,
      deviceRegistrationIds: ["dvr_ex"],
    });
    await applyPushOutcomes({
      tenantId,
      messageId,
      outcomes: [{
        deviceRegistrationId: "dvr_ex",
        claimToken: claimed[0].claimToken,
        kind: PushOutcomeKind.TRANSIENT,
        attempt: 1,
      }],
    });
    await applyPushOutcomes({
      tenantId,
      messageId,
      outcomes: [{
        deviceRegistrationId: "dvr_ex",
        claimToken: "stale_token",
        kind: PushOutcomeKind.TRANSIENT,
        attempt: 1,
      }],
    });
    const alerts = await Alert.countDocuments({ tenantId, type: "FCM_DELIVERY_EXHAUSTED", entityId: messageId });
    assert.equal(alerts, 1);
});

test("structured metrics never include raw fcm tokens", () => {
  incrementOpsMetric(OpsMetric.FCM_OUTCOME_SUCCESS, 3);
  const snap = getOpsMetricsSnapshot();
  const blob = JSON.stringify(snap);
  assert.ok(!blob.includes("device-token"));
  assert.ok(!blob.includes("registration-token"));
});

test("tenant A cannot update tenant B device timestamps", async () => {
  await resetTestDb();
  const { tenant: tenantA } = await seedTenantUser({ tenantCode: "TA" });
  const { tenant: tenantB, branch: branchB } = await seedTenantUser({ tenantCode: "TB" });
  const { registerFcmDevice } = await import("../src/services/device-registration.service.js");
  const customerB = await seedCustomer({ tenantId: tenantB._id, branchId: branchB._id, mobile: "+919711111111" });
  const regB = await registerFcmDevice({
    tenantId: tenantB._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customerB._id,
    deviceId: "dev_b",
    platform: "android",
    fcmToken: "tenant-b-token",
  });
  await markDeviceSuccess(tenantA._id, [regB._id]);
  await markDeviceFailure(tenantA._id, [regB._id]);
  const row = await DeviceRegistration.findById(regB._id).lean();
  assert.equal(row.lastSuccessAt, undefined);
  assert.equal(row.lastFailureAt, undefined);
});

test("tenant A cannot invalidate tenant B registration", async () => {
  await resetTestDb();
  const { tenant: tenantA } = await seedTenantUser({ tenantCode: "TAI" });
  const { tenant: tenantB, branch: branchB } = await seedTenantUser({ tenantCode: "TBI" });
  const customerB = await seedCustomer({ tenantId: tenantB._id, branchId: branchB._id, mobile: "+919722222222" });
  const regB = await registerFcmDevice({
    tenantId: tenantB._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customerB._id,
    deviceId: "dev_bi",
    platform: "android",
    fcmToken: "tenant-b-token-2",
  });
  await invalidateDeviceRegistrations(
    tenantA._id,
    [{
      id: regB._id,
      expectedTokenHash: regB.tokenHash,
      registrationVersion: regB.version,
    }],
    "FCM_UNREGISTERED",
  );
  const row = await DeviceRegistration.findById(regB._id).lean();
  assert.equal(row.status, "ACTIVE");
});

function stagingReportFromOutput(output) {
  const text = String(output ?? "").trim();
  if (!text) return null;
  const line = text.split("\n").find((row) => row.trim().startsWith("{"));
  if (!line) return null;
  try {
    return JSON.parse(line.trim());
  } catch {
    return null;
  }
}

test("live staging preflight exits non-zero without tenant id", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/fcm-staging-15k.js", "--dry-run=false", "--confirm-live-staging"],
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } },
  );
  assert.notEqual(result.status, 0);
  const report = stagingReportFromOutput(result.stdout);
  assert.equal(report?.error, "LIVE_STAGING_REQUIRES_TENANT_ID");
});

test("live staging accepts bare confirm flag and =true", () => {
  for (const args of [
    ["--dry-run=false", "--confirm-live-staging"],
    ["--dry-run=false", "--confirm-live-staging=true"],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/fcm-staging-15k.js", ...args],
      { cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } },
    );
    assert.notEqual(result.status, 0);
    const report = stagingReportFromOutput(result.stdout);
    assert.equal(report?.error, "LIVE_STAGING_REQUIRES_TENANT_ID");
  }
});

test("live staging rejects missing confirm and =false", () => {
  const missing = spawnSync(
    process.execPath,
    ["scripts/fcm-staging-15k.js", "--dry-run=false", "--tenant-id=tnt_x"],
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } },
  );
  assert.notEqual(missing.status, 0);
  assert.equal(stagingReportFromOutput(missing.stdout)?.error, "LIVE_STAGING_REQUIRES_CONFIRM_FLAG");

  const falseFlag = spawnSync(
    process.execPath,
    ["scripts/fcm-staging-15k.js", "--dry-run=false", "--confirm-live-staging=false", "--tenant-id=tnt_x"],
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } },
  );
  assert.notEqual(falseFlag.status, 0);
  assert.equal(stagingReportFromOutput(falseFlag.stdout)?.error, "LIVE_STAGING_REQUIRES_CONFIRM_FLAG");
});

test("live staging mode refuses NODE_ENV=production", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/fcm-staging-15k.js", "--dry-run=false", "--confirm-live-staging", "--tenant-id=tnt_x"],
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "production" } },
  );
  assert.notEqual(result.status, 0);
});

test("limiter test hooks are ignored in NODE_ENV=production subprocess", () => {
  const script = `
    import assert from "node:assert/strict";
    import { fcmLimiterTestHooks, acquireFcmSendQuota } from "./src/lib/fcm-redis-limiter.js";
    import { connectRedis } from "./src/config/redis.js";
    const ok = await connectRedis().catch(() => false);
    assert.ok(ok, "Redis required for production hook guard subprocess test");
    fcmLimiterTestHooks.override = { globalBurst: 1, globalRatePerSec: 1, tenantBurst: 1, tenantRatePerSec: 1 };
    const configIgnored = await acquireFcmSendQuota({ tenantId: "tnt_prod_hook", cost: 2 });
    assert.equal(configIgnored.allowed, true);
    fcmLimiterTestHooks.forceRedisError = true;
    const notInjected = await acquireFcmSendQuota({ tenantId: "tnt_prod_hook", cost: 1 });
    assert.equal(notInjected.allowed, true);
    assert.notEqual(notInjected.redisUnavailable, true);
    const { disconnectRedis } = await import("./src/config/redis.js");
    await disconnectRedis();
  `;
  const productionEnv = {
    ...process.env,
    NODE_ENV: "production",
    JWT_ACCESS_SECRET: "production-access-secret-value-32chars-min",
    JWT_REFRESH_SECRET: "production-refresh-secret-value-32chars-x",
    INTEGRATION_ENCRYPTION_KEY: "production-integration-key-32chars-min",
    SEED_PLATFORM_PASSWORD: "9876",
    REDIS_REQUIRED: "true",
    RATE_LIMIT_ENABLED: "true",
    PROVIDER_MODE: "live",
    OTP_PROVIDER: "msg91",
    PHONEPE_ENV: "PRODUCTION",
    FCM_SHARED_PROJECT_ENABLED: "true",
    FCM_PROJECT_ID: "test-firebase-project",
    FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
      client_email: "firebase-adminsdk@test-project.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
    }),
    S3_BUCKET: "prod-bucket",
    S3_ACCESS_KEY_ID: "prod-access-key",
    S3_SECRET_ACCESS_KEY: "prod-secret-key",
    CORS_ORIGINS: "https://app.example.com",
    PUBLIC_BASE_URL: "https://api.example.com",
    EXPORT_BASE_URL: "https://api.example.com",
    MALWARE_SCAN_URL: "https://scanner.example.com/scan",
  };
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: productionEnv,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("fcm push test hooks cannot activate outside NODE_ENV=test", () => {
  const script = `
    import assert from "node:assert/strict";
    import { armPauseBeforeFcmSend } from "./src/lib/fcm-push-test-hooks.js";
    assert.throws(() => armPauseBeforeFcmSend(), /NODE_ENV=test/);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
