import test from "node:test";
import assert from "node:assert/strict";
import { schedulerRepeatableJobs } from "../src/schedulers/repeatable-jobs.js";
import {
  QueueKind,
  queueRetryPolicySummary,
  repeatableJobOpts,
} from "../src/lib/queue-retry-policy.js";

test("every repeatable scheduler registration has explicit attempts and exponential backoff", () => {
  assert.ok(schedulerRepeatableJobs.length >= 10);
  for (const def of schedulerRepeatableJobs) {
    assert.ok(def.opts, `missing opts for ${def.id}`);
    assert.ok(def.opts.attempts >= 1, def.id);
    assert.equal(def.opts.backoff?.type, "exponential", def.id);
    assert.ok(def.opts.backoff?.delay >= 1000, def.id);
    assert.equal(def.opts.removeOnComplete, 1000, def.id);
    assert.equal(def.opts.removeOnFail, 5000, def.id);
  }
});

test("queue-specific retry defaults are bounded and distinct", () => {
  const summary = queueRetryPolicySummary();
  assert.equal(summary.scheduler.attempts, repeatableJobOpts(QueueKind.SCHEDULER).attempts);
  assert.equal(summary.payments.attempts, repeatableJobOpts(QueueKind.PAYMENTS).attempts);
  assert.equal(summary.maintenance.attempts, repeatableJobOpts(QueueKind.MAINTENANCE).attempts);
  assert.ok(summary.scheduler.backoffMs >= 1000);
  assert.ok(summary.payments.backoffMs >= 1000);
  assert.ok(summary.maintenance.backoffMs >= 1000);
});
