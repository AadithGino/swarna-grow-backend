import test from "node:test";
import assert from "node:assert/strict";
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { env } from "../src/config/env.js";
import { createId } from "../src/lib/ids.js";
import { fanoutDueJobId } from "../src/lib/fanout-not-due-schedule.js";
import { setCalendarDateOverrideForTests, resetCalendarDateOverrideForTests, now as calendarNow } from "../src/lib/date.js";
import { ensureRunnableMaintenanceJob } from "../src/lib/maintenance-queue-job.js";

test.beforeEach(() => {
  resetCalendarDateOverrideForTests();
});

test.afterEach(() => {
  resetCalendarDateOverrideForTests();
});

test("NOT_DUE delayed fanout job uses positive delay and dedupes (Redis integration)", async () => {
  const probe = new IORedis(env.REDIS_URL, { connectTimeout: 1500, maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await probe.connect();
    await probe.ping();
  } catch (error) {
    test.skip(`Redis unavailable: ${error.message}`);
    return;
  } finally {
    await probe.quit();
  }

  setCalendarDateOverrideForTests("2026-06-14");
  const broadcastId = createId("pb");
  const resumeAt = new Date("2026-06-14T18:30:00.000Z");
  const delayMs = Math.max(0, resumeAt.getTime() - calendarNow().valueOf());
  assert.ok(delayMs > 0, "expected future delay under calendar override");

  const queueName = `test-not-due-${createId("q")}`;
  const queue = new Queue(queueName, { connection: { url: env.REDIS_URL } });
  const jobId = fanoutDueJobId(broadcastId, resumeAt, "2026-06-15");
  try {
    const first = await ensureRunnableMaintenanceJob(
      queue,
      "push-broadcast-fanout",
      { broadcastId },
      jobId,
      { delay: delayMs },
    );
    assert.equal(first.scheduled, true);
    const job = await queue.getJob(jobId);
    assert.ok(job);
    assert.ok(job.opts.delay >= delayMs - 5000, "job delay should reflect due instant");

    const second = await ensureRunnableMaintenanceJob(
      queue,
      "push-broadcast-fanout",
      { broadcastId },
      jobId,
      { delay: delayMs },
    );
    assert.equal(second.alreadyPending, true);
  } finally {
    await queue.obliterate({ force: true });
    await queue.close();
  }
});
