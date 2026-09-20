import { getRedis, redisReady } from "../config/redis.js";

const KEY_PREFIX = "fcm:shared-metrics:";
const TTL_SEC = 86_400;

/** Low-cardinality FCM counters visible across worker processes (no tenant/customer/token ids). */
export const FcmSharedMetric = Object.freeze({
  LIMITER_DENIED_GLOBAL: "limiter_denied_global",
  LIMITER_DENIED_TENANT: "limiter_denied_tenant",
  LIMITER_REDIS_ERROR: "limiter_redis_error",
  SEND_DEFERRED: "send_deferred",
  SEND_ATTEMPT: "send_attempt",
  DELIVERY_SUCCEEDED: "delivery_succeeded",
  DELIVERY_TRANSIENT: "delivery_transient",
  DELIVERY_PERMANENT: "delivery_permanent",
  DELIVERY_EXHAUSTED: "delivery_exhausted",
});

function metricKey(name) {
  return `${KEY_PREFIX}${name}`;
}

/** Best-effort; never throws — delivery must not depend on metrics. */
export async function incrementSharedFcmMetric(name, by = 1) {
  if (!name || by <= 0 || !redisReady()) return false;
  try {
    const redis = getRedis();
    const key = metricKey(name);
    await redis.multi().incrby(key, by).expire(key, TTL_SEC).exec();
    return true;
  } catch {
    return false;
  }
}

export async function getSharedFcmMetricsSnapshot() {
  if (!redisReady()) {
    throw new Error("FCM_SHARED_METRICS_REDIS_UNAVAILABLE");
  }
  const redis = getRedis();
  const keys = await redis.keys(`${KEY_PREFIX}*`);
  const counters = {};
  if (keys.length) {
    const values = await redis.mget(...keys);
    keys.forEach((key, idx) => {
      const short = key.slice(KEY_PREFIX.length);
      counters[short] = Number(values[idx] ?? 0);
    });
  }
  return { counters };
}

export function diffSharedFcmMetrics(before, after) {
  const delta = {};
  const names = new Set([
    ...Object.keys(before?.counters ?? {}),
    ...Object.keys(after?.counters ?? {}),
  ]);
  for (const name of names) {
    const diff = (after?.counters?.[name] ?? 0) - (before?.counters?.[name] ?? 0);
    if (diff !== 0) delta[name] = diff;
  }
  return delta;
}

export async function resetSharedFcmMetricsForTests() {
  if (!redisReady()) return;
  const redis = getRedis();
  const keys = await redis.keys(`${KEY_PREFIX}*`);
  if (keys.length) await redis.del(...keys);
}
