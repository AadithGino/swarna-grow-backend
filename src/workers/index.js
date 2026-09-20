import { Worker } from "bullmq";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { connectRedis, disconnectRedis, getRedis } from "../config/redis.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { startWorkerHeartbeat, startWorkerRoleHeartbeat } from "../lib/worker-heartbeat.js";
import {
  processExport,
  processMaintenance,
  processMessage,
  processOutbox,
  processPaymentsMaintenance,
  processScheduler,
  processWebhook,
} from "./processors.js";

await connectDatabase(); const ready = await connectRedis(); if (!ready) throw new Error("Redis is required for workers");
startWorkerHeartbeat();
const connection = getRedis();
const workerOpts = { connection, prefix: "swarnagrow" };
const schedulerWorker = new Worker("scheduler", processScheduler, { ...workerOpts, concurrency: 1 });
const paymentsWorker = new Worker("payments", processPaymentsMaintenance, { ...workerOpts, concurrency: 2 });
startWorkerRoleHeartbeat("scheduler");
startWorkerRoleHeartbeat("payments");
const workers = [
  new Worker("messages", processMessage, {
    ...workerOpts,
    concurrency: env.MESSAGE_WORKER_CONCURRENCY ?? 40,
  }),
  new Worker("webhooks", processWebhook, { ...workerOpts, concurrency: 10 }),
  new Worker("outbox", processOutbox, { ...workerOpts, concurrency: 20 }),
  new Worker("exports", processExport, { ...workerOpts, concurrency: 2 }),
  schedulerWorker,
  paymentsWorker,
  new Worker("maintenance", processMaintenance, { ...workerOpts, concurrency: 2 }),
];
for (const worker of workers) worker.on("failed", (job, error) => logger.error({ err: error, jobId: job?.id, queue: worker.name }, "Background job failed"));
async function shutdown(signal) { logger.info({ signal }, "Worker shutdown"); await Promise.all(workers.map((worker) => worker.close())); await disconnectRedis(); await disconnectDatabase(); process.exit(0); }
process.on("SIGTERM", () => void shutdown("SIGTERM")); process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => { logger.fatal({ err: reason }, "Unhandled promise rejection"); void shutdown("unhandledRejection"); });
process.on("uncaughtException", (error) => { logger.fatal({ err: error }, "Uncaught exception"); void shutdown("uncaughtException"); });
