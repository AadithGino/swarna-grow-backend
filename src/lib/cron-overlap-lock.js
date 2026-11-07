import { getRedis } from "../config/redis.js";

const LOCK_KEY = "swarna:cron:queue-tick:overlap:v1";
const DEFAULT_TTL_SEC = 55;

/**
 * Best-effort single-flight lock for serverless cron (one tick per key per TTL).
 * @returns {Promise<boolean>}
 */
export async function tryAcquireCronQueueTickLock(ttlSec = DEFAULT_TTL_SEC) {
  const redis = getRedis();
  const token = `owner:${process.pid}:${Date.now()}`;
  const r = await redis.set(LOCK_KEY, token, "EX", ttlSec, "NX");
  return r === "OK";
}

export async function releaseCronQueueTickLock() {
  try {
    const redis = getRedis();
    await redis.del(LOCK_KEY);
  } catch {
    /* best-effort */
  }
}
