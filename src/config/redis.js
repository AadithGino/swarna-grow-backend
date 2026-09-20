import IORedis from "ioredis";
import { env } from "./env.js";
import { logger } from "./logger.js";

let redis;
export function getRedis() {
  if (!redis) {
    redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: true });
    redis.on("error", (error) => logger.error({ err: error }, "Redis error"));
  }
  return redis;
}

export async function connectRedis() {
  const client = getRedis();
  try { if (client.status === "wait") await client.connect(); await client.ping(); return true; }
  catch (error) { if (env.REDIS_REQUIRED) throw error; logger.warn({ err: error }, "Redis unavailable; asynchronous features are degraded"); return false; }
}

export const redisReady = () => Boolean(redis && redis.status === "ready");
export async function disconnectRedis() {
  if (!redis) return;
  try {
    if (redis.status === "ready" || redis.status === "connect") await redis.quit();
    else redis.disconnect();
  } catch {
    try { redis.disconnect(); } catch { /* ignore */ }
  }
  redis = undefined;
}
