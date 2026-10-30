import IORedis from "ioredis";
import { env } from "./env.js";
import { logger } from "./logger.js";

const isServerless = Boolean(process.env.VERCEL);
const CONNECT_BUDGET_MS = isServerless ? 2_500 : 10_000;

let redis;

export function getRedis() {
  if (!redis) {
    redis = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: isServerless ? 1 : null,
      enableReadyCheck: true,
      lazyConnect: true,
      connectTimeout: isServerless ? 2_000 : 10_000,
      commandTimeout: isServerless ? 2_000 : undefined,
      enableOfflineQueue: !isServerless,
    });
    redis.on("error", (error) => logger.error({ err: error }, "Redis error"));
  }
  return redis;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

export async function connectRedis() {
  const client = getRedis();
  try {
    if (client.status === "wait") {
      await withTimeout(client.connect(), CONNECT_BUDGET_MS, "Redis connect");
    }
    await withTimeout(client.ping(), Math.min(CONNECT_BUDGET_MS, 2_000), "Redis ping");
    return true;
  } catch (error) {
    if (env.REDIS_REQUIRED) throw error;
    logger.warn({ err: error }, "Redis unavailable; asynchronous features are degraded");
    return false;
  }
}

export const redisReady = () => Boolean(redis && redis.status === "ready");

export async function disconnectRedis() {
  if (!redis) return;
  try {
    if (redis.status === "ready" || redis.status === "connect") await redis.quit();
    else redis.disconnect();
  } catch {
    try {
      redis.disconnect();
    } catch {
      /* ignore */
    }
  }
  redis = undefined;
}
