import { connectRedis, disconnectRedis } from "../config/redis.js";
import { env } from "../config/env.js";
import { getQueue, closeQueues } from "../queues/index.js";
import { logger } from "../config/logger.js";
import { requiredWorkerRolesReady } from "../lib/worker-heartbeat.js";
import { QueueKind } from "../lib/queue-retry-policy.js";
import { schedulerRepeatableJobs } from "./repeatable-jobs.js";

if (!(await connectRedis())) throw new Error("Redis is required for the scheduler");

async function assertWorkersBeforeSchedulerRegistration() {
  if (env.NODE_ENV !== "production" && env.SCHEDULER_REQUIRE_WORKER_ROLES !== "true") {
    return;
  }
  const ready = await requiredWorkerRolesReady(["scheduler", "payments"]);
  if (!ready) {
    throw new Error(
      "SCHEDULER_REGISTRATION_BLOCKED: scheduler and payments workers must heartbeat before repeatable jobs are registered",
    );
  }
}

await assertWorkersBeforeSchedulerRegistration();

const queueByKind = {
  [QueueKind.SCHEDULER]: getQueue("scheduler"),
  [QueueKind.PAYMENTS]: getQueue("payments"),
  [QueueKind.MAINTENANCE]: getQueue("maintenance"),
};

await Promise.all(
  schedulerRepeatableJobs.map((def) => {
    const queue = queueByKind[def.queue];
    return queue.upsertJobScheduler(
      def.id,
      def.repeat,
      { name: def.name, data: def.data, opts: def.opts },
    );
  }),
);
logger.info("Schedulers registered");
await closeQueues();
await disconnectRedis();
