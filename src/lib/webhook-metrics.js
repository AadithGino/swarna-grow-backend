import {
  getOpsMetricsSnapshot,
  incrementOpsMetric,
  observeOpsDuration,
  OpsMetric,
  resetOpsMetricsForTests,
} from "./ops-metrics.js";

export const WebhookMetric = Object.freeze({
  RECEIVED: OpsMetric.WEBHOOK_RECEIVED,
  DUPLICATE: OpsMetric.WEBHOOK_DUPLICATE,
  SIGNATURE_FAILED: OpsMetric.WEBHOOK_SIGNATURE_FAILED,
  BODY_TOO_LARGE: OpsMetric.WEBHOOK_BODY_TOO_LARGE,
  RATE_LIMITED: OpsMetric.WEBHOOK_RATE_LIMITED,
  PROCESSING_COMPLETED: OpsMetric.WEBHOOK_PROCESSING_COMPLETED,
  PROCESSING_FAILED: OpsMetric.WEBHOOK_PROCESSING_FAILED,
  DEAD_LETTER: OpsMetric.WEBHOOK_DEAD_LETTER,
  LEASE_RECLAIMED: OpsMetric.WEBHOOK_LEASE_RECLAIMED,
  REPLAY: OpsMetric.WEBHOOK_REPLAY,
});

export function incrementWebhookMetric(name, by = 1) {
  incrementOpsMetric(name, by);
  if (name === OpsMetric.WEBHOOK_DUPLICATE) {
    incrementOpsMetric(OpsMetric.PHONEPE_WEBHOOK_DUPLICATE, by);
  }
}

export function observeWebhookProcessingMs(ms) {
  observeOpsDuration("webhook.processing.ms", ms);
}

export function getWebhookMetricsSnapshot() {
  const all = getOpsMetricsSnapshot();
  const webhookCounters = {};
  for (const [key, value] of Object.entries(all.counters)) {
    if (key.startsWith("webhook.")) webhookCounters[key] = value;
  }
  return webhookCounters;
}

export { resetOpsMetricsForTests, resetOpsMetricsForTests as resetWebhookMetricsForTests };
