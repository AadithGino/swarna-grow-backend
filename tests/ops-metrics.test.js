import test from "node:test";
import assert from "node:assert/strict";
import { PushOutcomeKind } from "../src/lib/fcm-outcomes.js";
import {
  OpsMetric,
  getOpsMetricsSnapshot,
  incrementOpsMetric,
  recordFcmOutcomes,
  recordPhonePeReconcileOutcome,
  resetOpsMetricsForTests,
} from "../src/lib/ops-metrics.js";
import { evaluateQueueHealth } from "../src/lib/queue-health.js";

test("ops metrics aggregate counters without high-cardinality labels", () => {
  resetOpsMetricsForTests();
  recordFcmOutcomes([
    { kind: PushOutcomeKind.SUCCESS },
    { kind: PushOutcomeKind.PERMANENT_INVALID_TOKEN },
  ]);
  recordPhonePeReconcileOutcome("COMPLETED");
  incrementOpsMetric(OpsMetric.WEBHOOK_DUPLICATE, 2);

  const snap = getOpsMetricsSnapshot();
  assert.equal(snap.counters[OpsMetric.FCM_OUTCOME_SUCCESS], 1);
  assert.equal(snap.counters[OpsMetric.FCM_OUTCOME_PERMANENT_INVALID], 1);
  assert.equal(snap.counters[OpsMetric.PHONEPE_RECONCILE_COMPLETED], 1);
  assert.equal(snap.counters[OpsMetric.WEBHOOK_DUPLICATE], 2);
});

test("queue health evaluation flags lag and dead letter thresholds", () => {
  const healthy = evaluateQueueHealth({
    available: true,
    oldestMessageQueuedMs: 1_000,
    queues: { webhooks: { waiting: 0 } },
    webhookBacklog: { queued: 0, processing: 0, deadLetter: 0 },
  });
  assert.equal(healthy.healthy, true);

  const unhealthy = evaluateQueueHealth({
    available: true,
    oldestMessageQueuedMs: 999_999_999,
    queues: { webhooks: { waiting: 999_999 } },
    webhookBacklog: { queued: 999_999, processing: 0, deadLetter: 999 },
  });
  assert.equal(unhealthy.healthy, false);
  assert.ok(unhealthy.warnings.includes("MESSAGE_QUEUE_LAG"));
  assert.ok(unhealthy.warnings.includes("WEBHOOK_BULLMQ_DEPTH"));
  assert.ok(unhealthy.warnings.includes("WEBHOOK_EVENT_BACKLOG"));
  assert.ok(unhealthy.warnings.includes("WEBHOOK_DEAD_LETTER"));
});
