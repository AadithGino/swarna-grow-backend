import { env } from "../config/env.js";

export const QueueKind = Object.freeze({
  SCHEDULER: "scheduler",
  PAYMENTS: "payments",
  MAINTENANCE: "maintenance",
});

function attemptsFor(kind) {
  if (kind === QueueKind.SCHEDULER) return env.SCHEDULER_JOB_ATTEMPTS ?? 3;
  if (kind === QueueKind.PAYMENTS) return env.PAYMENTS_JOB_ATTEMPTS ?? 5;
  return env.MAINTENANCE_JOB_ATTEMPTS ?? 5;
}

function backoffMsFor(kind) {
  if (kind === QueueKind.SCHEDULER) return env.SCHEDULER_JOB_BACKOFF_MS ?? 30_000;
  if (kind === QueueKind.PAYMENTS) return env.PAYMENTS_JOB_BACKOFF_MS ?? 15_000;
  return env.MAINTENANCE_JOB_BACKOFF_MS ?? 15_000;
}

/** BullMQ job-template opts merged into upsertJobScheduler's third argument. */
export function repeatableJobOpts(kind) {
  return {
    attempts: attemptsFor(kind),
    backoff: {
      type: "exponential",
      delay: backoffMsFor(kind),
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  };
}

export function buildRepeatableJobTemplate(name, data, kind) {
  return {
    name,
    data: data ?? {},
    opts: repeatableJobOpts(kind),
  };
}

/** Exported for tests — documents exhausted-job behavior (failed job retained per queue removeOnFail). */
export function queueRetryPolicySummary() {
  return {
    scheduler: { attempts: attemptsFor(QueueKind.SCHEDULER), backoffMs: backoffMsFor(QueueKind.SCHEDULER) },
    payments: { attempts: attemptsFor(QueueKind.PAYMENTS), backoffMs: backoffMsFor(QueueKind.PAYMENTS) },
    maintenance: { attempts: attemptsFor(QueueKind.MAINTENANCE), backoffMs: backoffMsFor(QueueKind.MAINTENANCE) },
  };
}
