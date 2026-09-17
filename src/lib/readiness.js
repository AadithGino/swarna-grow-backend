import { env } from "../config/env.js";
import { databaseReady } from "../config/database.js";
import { redisReady } from "../config/redis.js";
import { workerProcessReady } from "./worker-heartbeat.js";

export function computeReadiness({ dbOk, redisOk, nodeEnv, redisRequired, workersOk = false }) {
  const ready = dbOk && (nodeEnv !== "production" || redisOk);
  return {
    ready,
    data: {
      database: dbOk ? "ready" : "unavailable",
      queue: redisOk ? "ready" : redisRequired ? "unavailable" : "optional-unavailable",
      workers: workersOk ? "ready" : redisOk ? "unavailable" : "optional-unavailable",
    },
  };
}

export async function getReadinessState() {
  const dbOk = databaseReady();
  const redisOk = redisReady();
  const workersOk = redisOk ? await workerProcessReady() : false;
  return computeReadiness({
    dbOk,
    redisOk,
    nodeEnv: env.NODE_ENV,
    redisRequired: env.REDIS_REQUIRED,
    workersOk,
  });
}
