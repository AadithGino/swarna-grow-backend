import test from "node:test";
import assert from "node:assert/strict";
import { schedulerRepeatableJobs } from "../src/schedulers/repeatable-jobs.js";
import { QueueKind, repeatableJobOpts } from "../src/lib/queue-retry-policy.js";

test("repeatable job registration template matches upsertJobScheduler shape", () => {
  const registrations = [];
  const queueByKind = {
    [QueueKind.SCHEDULER]: { kind: "scheduler" },
    [QueueKind.PAYMENTS]: { kind: "payments" },
    [QueueKind.MAINTENANCE]: { kind: "maintenance" },
  };

  for (const def of schedulerRepeatableJobs) {
    const queue = queueByKind[def.queue];
    assert.ok(queue, def.id);
    registrations.push({
      queue: queue.kind,
      id: def.id,
      repeat: def.repeat,
      template: { name: def.name, data: def.data, opts: def.opts },
    });
  }

  assert.ok(registrations.length >= 10);
  for (const row of registrations) {
    const { template } = row;
    assert.equal(typeof template.name, "string", row.id);
    assert.ok(template.data != null, row.id);
    assert.ok(template.opts, row.id);
    assert.ok(template.opts.attempts >= 1, row.id);
    assert.equal(template.opts.backoff?.type, "exponential", row.id);
    assert.ok(template.opts.backoff?.delay >= 1000, row.id);
    assert.equal(template.opts.removeOnComplete, 1000, row.id);
    assert.equal(template.opts.removeOnFail, 5000, row.id);
    assert.deepEqual(template.opts, repeatableJobOpts(
      row.queue === "scheduler"
        ? QueueKind.SCHEDULER
        : row.queue === "payments"
          ? QueueKind.PAYMENTS
          : QueueKind.MAINTENANCE,
    ));
  }
});
