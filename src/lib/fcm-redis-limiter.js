import { env } from "../config/env.js";
import { getRedis, redisReady } from "../config/redis.js";
import { fcmLimiterBurstCaps } from "./fcm-quota-chunk.js";
import { FcmSharedMetric, incrementSharedFcmMetric } from "./fcm-redis-metrics.js";
import { incrementOpsMetric, OpsMetric } from "./ops-metrics.js";

function limiterTestHooksActive() {
  return process.env.NODE_ENV === "test";
}

function readLimiterTestOverride() {
  return limiterTestHooksActive() ? fcmLimiterTestHooks.override : null;
}

function readLimiterForceRedisError() {
  return limiterTestHooksActive() && fcmLimiterTestHooks.forceRedisError;
}

export function resetFcmLimiterTestHooksForTests() {
  fcmLimiterTestHooks.forceRedisError = false;
  fcmLimiterTestHooks.override = null;
}

const COMBINED_ACQUIRE_SCRIPT = `
local globalKey = KEYS[1]
local tenantKey = KEYS[2]

local gCap = tonumber(ARGV[1])
local gRate = tonumber(ARGV[2])
local tCap = tonumber(ARGV[3])
local tRate = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])
local ttlSec = tonumber(ARGV[6])

local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local function refill(key, cap, rate)
  local data = redis.call('HMGET', key, 'tokens', 'lastMs')
  local tokens = tonumber(data[1])
  local lastMs = tonumber(data[2])
  if tokens == nil then
    tokens = cap
    lastMs = nowMs
  else
    local elapsedSec = math.max(0, (nowMs - lastMs) / 1000)
    tokens = math.min(cap, tokens + elapsedSec * rate)
    lastMs = nowMs
  end
  return tokens, lastMs
end

local function persist(key, tokens, lastMs)
  redis.call('HMSET', key, 'tokens', tokens, 'lastMs', lastMs)
  redis.call('EXPIRE', key, ttlSec)
end

if cost > gCap or cost > tCap then
  redis.call('EXPIRE', globalKey, ttlSec)
  redis.call('EXPIRE', tenantKey, ttlSec)
  return {0, 60000, 3}
end

local gTokens, gLast = refill(globalKey, gCap, gRate)
local tTokens, tLast = refill(tenantKey, tCap, tRate)

local scope = 0
local retryMs = 0

if gTokens < cost then
  scope = 1
  local deficit = cost - gTokens
  retryMs = math.ceil((deficit / gRate) * 1000)
  if retryMs < 1 then retryMs = 1 end
elseif tTokens < cost then
  scope = 2
  local deficit = cost - tTokens
  retryMs = math.ceil((deficit / tRate) * 1000)
  if retryMs < 1 then retryMs = 1 end
end

if scope > 0 then
  persist(globalKey, gTokens, gLast)
  persist(tenantKey, tTokens, tLast)
  return {0, retryMs, scope}
end

gTokens = gTokens - cost
tTokens = tTokens - cost
persist(globalKey, gTokens, gLast)
persist(tenantKey, tTokens, tLast)
return {1, 0, 0}
`;

let combinedSha;

/** @internal Test-only fault injection (guarded in acquire). */
export const fcmLimiterTestHooks = {
  forceRedisError: false,
  /** @type {null | { globalBurst: number, globalRatePerSec: number, tenantBurst: number, tenantRatePerSec: number }} */
  override: null,
};

function globalBucketConfig() {
  const override = readLimiterTestOverride();
  if (override) {
    const o = override;
    const ttlSec = Math.max(60, env.FCM_RATE_LIMIT_KEY_TTL_SEC ?? 3600);
    return {
      ratePerSec: Math.max(0.0001, o.globalRatePerSec),
      burst: o.globalBurst,
      ttlSec,
    };
  }
  const ratePerSec = Math.max(1, env.FCM_RATE_LIMIT_GLOBAL_PER_SEC ?? 200);
  const { globalBurst: burst } = fcmLimiterBurstCaps();
  const ttlSec = Math.max(60, env.FCM_RATE_LIMIT_KEY_TTL_SEC ?? 3600);
  return { ratePerSec, burst, ttlSec };
}

function tenantBucketConfig() {
  const override = readLimiterTestOverride();
  if (override) {
    const o = override;
    const ttlSec = Math.max(60, env.FCM_RATE_LIMIT_KEY_TTL_SEC ?? 3600);
    return {
      ratePerSec: Math.max(0.0001, o.tenantRatePerSec),
      burst: o.tenantBurst,
      ttlSec,
    };
  }
  const ratePerSec = Math.max(1, env.FCM_RATE_LIMIT_TENANT_PER_SEC ?? 80);
  const { tenantBurst: burst } = fcmLimiterBurstCaps();
  const ttlSec = Math.max(60, env.FCM_RATE_LIMIT_KEY_TTL_SEC ?? 3600);
  return { ratePerSec, burst, ttlSec };
}

function sanitizeTenantKeyPart(tenantId) {
  return String(tenantId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

export function fcmLimiterGlobalKey() {
  return "fcm:{limiter}:global";
}

export function fcmLimiterTenantKey(tenantId) {
  return `fcm:{limiter}:tenant:${sanitizeTenantKeyPart(tenantId)}`;
}

async function loadCombinedScript(redis) {
  combinedSha = await redis.script("LOAD", COMBINED_ACQUIRE_SCRIPT);
}

async function evalCombinedAcquire(redis, tenantId, cost) {
  const globalConfig = globalBucketConfig();
  const tenantConfig = tenantBucketConfig();
  const keys = [fcmLimiterGlobalKey(), fcmLimiterTenantKey(tenantId)];
  const argv = [
    globalConfig.burst,
    globalConfig.ratePerSec,
    tenantConfig.burst,
    tenantConfig.ratePerSec,
    cost,
    globalConfig.ttlSec,
  ];
  if (!combinedSha) await loadCombinedScript(redis);
  try {
    return await redis.evalsha(combinedSha, keys.length, ...keys, ...argv);
  } catch (error) {
    if (String(error?.message ?? "").includes("NOSCRIPT")) {
      await loadCombinedScript(redis);
      return redis.evalsha(combinedSha, keys.length, ...keys, ...argv);
    }
    throw error;
  }
}

function mapScope(code) {
  if (code === 1) return "global";
  if (code === 2) return "tenant";
  if (code === 3) return "config";
  return "unknown";
}

/**
 * @returns {Promise<{ allowed: boolean, retryAfterMs?: number, scope?: string, redisUnavailable?: boolean }>}
 */
export async function acquireFcmSendQuota({ tenantId, cost = 1 }) {
  if (!tenantId) {
    return { allowed: false, retryAfterMs: 5000, scope: "config" };
  }
  const globalConfig = globalBucketConfig();
  const tenantConfig = tenantBucketConfig();
  const globalBurst = globalConfig.burst;
  const tenantBurst = tenantConfig.burst;
  if (cost > globalBurst || cost > tenantBurst) {
    return { allowed: false, retryAfterMs: 60_000, scope: "config" };
  }
  if (!redisReady()) {
    incrementOpsMetric(OpsMetric.FCM_LIMITER_REDIS_ERROR);
    const retryAfterMs = env.FCM_RATE_LIMIT_REDIS_UNAVAILABLE_MS ?? 5000;
    return { allowed: false, retryAfterMs, scope: "redis", redisUnavailable: true };
  }
  if (readLimiterForceRedisError()) {
    incrementOpsMetric(OpsMetric.FCM_LIMITER_REDIS_ERROR);
    void incrementSharedFcmMetric(FcmSharedMetric.LIMITER_REDIS_ERROR);
    const retryAfterMs = env.FCM_RATE_LIMIT_REDIS_UNAVAILABLE_MS ?? 5000;
    return { allowed: false, retryAfterMs, scope: "redis", redisUnavailable: true };
  }
  const redis = getRedis();
  try {
    let result;
    try {
      result = await evalCombinedAcquire(redis, tenantId, cost);
    } catch {
      try {
        combinedSha = undefined;
        result = await evalCombinedAcquire(redis, tenantId, cost);
      } catch {
        incrementOpsMetric(OpsMetric.FCM_LIMITER_REDIS_ERROR);
        void incrementSharedFcmMetric(FcmSharedMetric.LIMITER_REDIS_ERROR);
        const retryAfterMs = env.FCM_RATE_LIMIT_REDIS_UNAVAILABLE_MS ?? 5000;
        return { allowed: false, retryAfterMs, scope: "redis", redisUnavailable: true };
      }
    }
    const allowed = Number(result[0]) === 1;
    const retryAfterMs = Math.max(1, Number(result[1]) || 0);
    const scope = mapScope(Number(result[2]));
    if (!allowed) {
      incrementOpsMetric(OpsMetric.FCM_LIMITER_DENIED);
      if (scope === "global") {
        incrementOpsMetric(OpsMetric.FCM_LIMITER_DENIED_GLOBAL);
        void incrementSharedFcmMetric(FcmSharedMetric.LIMITER_DENIED_GLOBAL);
      }
      if (scope === "tenant") {
        incrementOpsMetric(OpsMetric.FCM_LIMITER_DENIED_TENANT);
        void incrementSharedFcmMetric(FcmSharedMetric.LIMITER_DENIED_TENANT);
      }
      return { allowed: false, retryAfterMs, scope };
    }
    incrementOpsMetric(OpsMetric.FCM_LIMITER_ALLOWED);
    return { allowed: true, retryAfterMs: 0 };
  } catch {
    incrementOpsMetric(OpsMetric.FCM_LIMITER_REDIS_ERROR);
    void incrementSharedFcmMetric(FcmSharedMetric.LIMITER_REDIS_ERROR);
    const retryAfterMs = env.FCM_RATE_LIMIT_REDIS_UNAVAILABLE_MS ?? 5000;
    return { allowed: false, retryAfterMs, scope: "redis", redisUnavailable: true };
  }
}

export function resetFcmLimiterScriptsForTests() {
  combinedSha = undefined;
}

export async function readLimiterBucketTokens(redis, key) {
  const tokens = await redis.hget(key, "tokens");
  return tokens == null ? null : Number(tokens);
}
