import { env } from "../config/env.js";
import { databaseReady } from "../config/database.js";
import { redisReady } from "../config/redis.js";
import { getProviderConfigurationStatus } from "./provider-config-status.js";
import { requiredWorkerRolesReady, workerProcessReady } from "./worker-heartbeat.js";
import { getOpsMetricsSnapshot } from "./ops-metrics.js";
import { evaluateQueueHealth, getQueueHealthSnapshot } from "./queue-health.js";

export function computeReadiness({
  dbOk,
  redisOk,
  nodeEnv,
  redisRequired,
  workersOk = false,
  workerRolesOk = true,
  configuration = null,
  queueHealth = null,
  metrics = null,
}) {
  const queueEvaluation = queueHealth ? evaluateQueueHealth(queueHealth) : { healthy: true, warnings: [] };
  const productionReady = redisOk && workersOk && workerRolesOk && queueEvaluation.healthy;
  const ready = dbOk && (nodeEnv !== "production" || productionReady);
  return {
    ready,
    data: {
      database: dbOk ? "ready" : "unavailable",
      queue: redisOk ? "ready" : redisRequired ? "unavailable" : "optional-unavailable",
      workers: workersOk ? "ready" : redisOk ? "unavailable" : "optional-unavailable",
      workerRoles: workerRolesOk ? "ready" : redisOk ? "unavailable" : "optional-unavailable",
      configuration: configuration ?? getProviderConfigurationStatus(),
      queues: queueHealth ?? { available: false },
      queueWarnings: queueEvaluation.warnings,
      metrics: metrics ?? getOpsMetricsSnapshot(),
    },
  };
}

export async function getReadinessState() {
  const dbOk = databaseReady();
  const redisOk = redisReady();
  const workersOk = redisOk ? await workerProcessReady() : false;
  const workerRolesOk = redisOk && env.NODE_ENV === "production"
    ? await requiredWorkerRolesReady(["scheduler", "payments"])
    : true;
  const queueHealth = redisOk ? await getQueueHealthSnapshot() : null;
  return computeReadiness({
    dbOk,
    redisOk,
    nodeEnv: env.NODE_ENV,
    redisRequired: env.REDIS_REQUIRED,
    workersOk,
    workerRolesOk,
    queueHealth,
  });
}
