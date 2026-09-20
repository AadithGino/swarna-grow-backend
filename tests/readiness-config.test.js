import test from "node:test";
import assert from "node:assert/strict";
import { computeReadiness } from "../src/lib/readiness.js";
import { resetOpsMetricsForTests } from "../src/lib/ops-metrics.js";

test("readiness includes non-secret configuration status", () => {
  resetOpsMetricsForTests();
  const { data } = computeReadiness({
    dbOk: true,
    redisOk: true,
    nodeEnv: "test",
    redisRequired: false,
    workersOk: false,
    configuration: {
      providerMode: "mock",
      rateLimiting: "enabled",
      fcm: "not-configured",
      s3: "configured",
    },
    queueHealth: {
      available: true,
      oldestMessageQueuedMs: 0,
      queues: {},
      webhookBacklog: { queued: 0, processing: 0, deadLetter: 0 },
    },
  });
  assert.equal(data.configuration.providerMode, "mock");
  assert.equal(data.configuration.fcm, "not-configured");
  assert.equal(data.workers, "unavailable");
  assert.ok(data.metrics);
  assert.equal(data.queueWarnings.length, 0);
});

test("production readiness fails when queue health warnings present", () => {
  const { ready, data } = computeReadiness({
    dbOk: true,
    redisOk: true,
    nodeEnv: "production",
    redisRequired: true,
    workersOk: true,
    queueHealth: {
      available: true,
      oldestMessageQueuedMs: 999_999_999,
      queues: { webhooks: { waiting: 0 } },
      webhookBacklog: { queued: 0, processing: 0, deadLetter: 0 },
    },
  });
  assert.equal(ready, false);
  assert.ok(data.queueWarnings.includes("MESSAGE_QUEUE_LAG"));
});
