import { PushOutcomeKind } from "./fcm-outcomes.js";

const counters = Object.create(null);
const durationTotals = Object.create(null);
const durationCounts = Object.create(null);
const lastRuns = Object.create(null);

/** Low-cardinality metric names only — never tenant/customer/token/order ids. */
export const OpsMetric = Object.freeze({
  FCM_OUTCOME_SUCCESS: "fcm.outcome.success",
  FCM_OUTCOME_PERMANENT_INVALID: "fcm.outcome.permanent_invalid",
  FCM_OUTCOME_PAYLOAD_ERROR: "fcm.outcome.payload_error",
  FCM_OUTCOME_TRANSIENT: "fcm.outcome.transient",
  FCM_OUTCOME_EXHAUSTED: "fcm.outcome.exhausted",
  FCM_OUTCOME_RATE_LIMITED: "fcm.outcome.rate_limited",
  FCM_LIMITER_ALLOWED: "fcm.limiter.allowed",
  FCM_LIMITER_DENIED: "fcm.limiter.denied",
  FCM_LIMITER_DENIED_GLOBAL: "fcm.limiter.denied_global",
  FCM_LIMITER_DENIED_TENANT: "fcm.limiter.denied_tenant",
  FCM_LIMITER_REDIS_ERROR: "fcm.limiter.redis_error",
  FCM_SEND_DEFERRED: "fcm.send.deferred",
  FCM_SEND_BATCH: "fcm.send.batch",
  FCM_CAMPAIGN_STARTED: "fcm.campaign.started",
  FCM_CAMPAIGN_COMPLETED: "fcm.campaign.completed",
  FCM_DELIVERY_EXHAUSTED_ALERT: "fcm.delivery.exhausted_alert",
  MESSAGE_STATUS_QUEUED: "message.status.queued",
  MESSAGE_STATUS_SENT: "message.status.sent",
  MESSAGE_STATUS_FAILED: "message.status.failed",
  BROADCAST_COMPLETED: "broadcast.completed",
  BROADCAST_FAILED: "broadcast.failed",
  BROADCAST_RESUMED: "broadcast.resumed",
  BROADCAST_FANOUT_CHUNK: "broadcast.fanout_chunk",
  PHONEPE_RECONCILE_COMPLETED: "phonepe.reconcile.completed",
  PHONEPE_RECONCILE_TERMINAL_FAILED: "phonepe.reconcile.terminal_failed",
  PHONEPE_RECONCILE_STILL_PENDING: "phonepe.reconcile.still_pending",
  PHONEPE_RECONCILE_TRANSIENT: "phonepe.reconcile.transient_error",
  PHONEPE_RECONCILE_DRIFT_REPAIRED: "phonepe.reconcile.drift_repaired",
  PHONEPE_REFUND_COMPLETED: "phonepe.refund.completed",
  PHONEPE_REFUND_FAILED: "phonepe.refund.failed",
  PHONEPE_REFUND_ACCEPTED: "phonepe.refund.accepted",
  PHONEPE_WEBHOOK_DUPLICATE: "phonepe.webhook.duplicate",
  PHONEPE_WEBHOOK_UNSUPPORTED: "phonepe.webhook.unsupported",
  PHONEPE_WEBHOOK_OUT_OF_ORDER: "phonepe.webhook.out_of_order",
  REMINDER_RUN: "reminder.scheduler.run",
  REMINDER_LEASE_CONTENTION: "reminder.scheduler.lease_contention",
  REMINDER_MESSAGES_QUEUED: "reminder.messages.queued",
  EXPORT_COMPLETED: "export.completed",
  EXPORT_FAILED: "export.failed",
  EXPORT_ROWS: "export.rows_total",
  EXPORT_BYTES: "export.bytes_total",
  WEBHOOK_RECEIVED: "webhook.received",
  WEBHOOK_DUPLICATE: "webhook.duplicate",
  WEBHOOK_SIGNATURE_FAILED: "webhook.signature_failed",
  WEBHOOK_BODY_TOO_LARGE: "webhook.body_too_large",
  WEBHOOK_RATE_LIMITED: "webhook.rate_limited",
  WEBHOOK_PROCESSING_COMPLETED: "webhook.processing_completed",
  WEBHOOK_PROCESSING_FAILED: "webhook.processing_failed",
  WEBHOOK_DEAD_LETTER: "webhook.dead_letter",
  WEBHOOK_LEASE_RECLAIMED: "webhook.lease_reclaimed",
  WEBHOOK_REPLAY: "webhook.replay",
  DISPATCH_CLAIM: "dispatch.claim",
  DISPATCH_ACK: "dispatch.ack",
  DISPATCH_RELEASE: "dispatch.release",
  DISPATCH_LEASE_RECLAIMED: "dispatch.lease_reclaimed",
  DISPATCH_QUEUE_ADD: "dispatch.queue_add",
  DISPATCH_QUEUE_DEDUPED: "dispatch.queue_deduped",
  LEGACY_OUTBOX_ORPHAN_COMPLETED: "legacy.outbox.message_send_orphan_completed",
  SCHEDULER_BATCH_PROCESSED: "scheduler.batch.processed",
  SCHEDULER_BATCH_SKIPPED: "scheduler.batch.skipped",
  SCHEDULER_BATCH_CONFLICT: "scheduler.batch.conflict",
  REMINDER_QUOTA_DENIED: "reminder.quota.denied",
  REMINDER_LEASE_LOST: "reminder.scheduler.lease_lost",
  REMINDER_CONTINUATION_SCHEDULED: "reminder.scheduler.continuation_scheduled",
  REMINDER_BACKLOG_REMAINING: "reminder.scheduler.backlog_remaining",
  PAYMENT_EXPIRY_PROCESSED: "payment.expiry.processed",
  PAYMENT_EXPIRY_EXPIRED: "payment.expiry.expired",
  PAYMENT_EXPIRY_DEFERRED: "payment.expiry.deferred",
  PAYMENT_EXPIRY_BACKLOG: "payment.expiry.backlog_remaining",
  WEBHOOK_RECLAIM_RECLAIMED: "webhook.reclaim.reclaimed",
  WEBHOOK_RECLAIM_CONFLICTED: "webhook.reclaim.conflicted",
  WEBHOOK_RECLAIM_BACKLOG: "webhook.reclaim.backlog_remaining",
  MAINTENANCE_SCAN_CONTINUATION: "maintenance.scan.continuation_scheduled",
  MAINTENANCE_SCAN_WRAPPED: "maintenance.scan.wrapped",
  MAINTENANCE_SCAN_LEASE_BUSY: "maintenance.scan.lease_busy",
  MAINTENANCE_SCAN_LEASE_LOST: "maintenance.scan.lease_lost",
});

export function incrementOpsMetric(name, by = 1) {
  if (!name || by <= 0) return;
  counters[name] = (counters[name] ?? 0) + by;
}

export function observeOpsDuration(name, ms) {
  if (!name || !Number.isFinite(ms) || ms < 0) return;
  durationTotals[name] = (durationTotals[name] ?? 0) + ms;
  durationCounts[name] = (durationCounts[name] ?? 0) + 1;
}

export function recordOpsLastRun(name, payload) {
  lastRuns[name] = { ...payload, recordedAt: new Date().toISOString() };
}

const FCM_OUTCOME_METRIC = Object.freeze({
  [PushOutcomeKind.SUCCESS]: OpsMetric.FCM_OUTCOME_SUCCESS,
  [PushOutcomeKind.PERMANENT_INVALID_TOKEN]: OpsMetric.FCM_OUTCOME_PERMANENT_INVALID,
  [PushOutcomeKind.PERMANENT_PAYLOAD_ERROR]: OpsMetric.FCM_OUTCOME_PAYLOAD_ERROR,
  [PushOutcomeKind.TRANSIENT]: OpsMetric.FCM_OUTCOME_TRANSIENT,
  [PushOutcomeKind.RATE_LIMITED]: OpsMetric.FCM_OUTCOME_RATE_LIMITED,
});

export function recordFcmOutcomes(outcomes = []) {
  for (const row of outcomes) {
    const metric = FCM_OUTCOME_METRIC[row?.kind];
    if (metric) incrementOpsMetric(metric);
  }
}

export function recordMessageStatusTransition(status) {
  const key = String(status ?? "").toUpperCase();
  if (key === "QUEUED") incrementOpsMetric(OpsMetric.MESSAGE_STATUS_QUEUED);
  else if (key === "SENT" || key === "DELIVERED") incrementOpsMetric(OpsMetric.MESSAGE_STATUS_SENT);
  else if (key === "FAILED") incrementOpsMetric(OpsMetric.MESSAGE_STATUS_FAILED);
}

export function recordReminderSchedulerRun(summary) {
  incrementOpsMetric(OpsMetric.REMINDER_RUN);
  if (summary.messagesQueued) incrementOpsMetric(OpsMetric.REMINDER_MESSAGES_QUEUED, summary.messagesQueued);
  if (summary.continuationScheduled) {
    incrementOpsMetric(OpsMetric.REMINDER_CONTINUATION_SCHEDULED, summary.continuationScheduled);
  }
  if (summary.remainingBacklog) {
    incrementOpsMetric(OpsMetric.REMINDER_BACKLOG_REMAINING, summary.remainingBacklog);
  }
  if (summary.leaseLost) incrementOpsMetric(OpsMetric.REMINDER_LEASE_LOST, summary.leaseLost);
  if (summary.skipped) incrementOpsMetric(OpsMetric.SCHEDULER_BATCH_SKIPPED, summary.skipped);
  observeOpsDuration("reminder.scheduler.ms", summary.durationMs ?? 0);
  recordOpsLastRun("reminder.scheduler", summary);
}

export function recordExportRun({ success, rowCount = 0, bytes = 0, durationMs }) {
  incrementOpsMetric(success ? OpsMetric.EXPORT_COMPLETED : OpsMetric.EXPORT_FAILED);
  if (rowCount) incrementOpsMetric(OpsMetric.EXPORT_ROWS, rowCount);
  if (bytes) incrementOpsMetric(OpsMetric.EXPORT_BYTES, bytes);
  observeOpsDuration("export.generation.ms", durationMs);
}

export function recordPhonePeReconcileOutcome(outcome) {
  const map = {
    COMPLETED: OpsMetric.PHONEPE_RECONCILE_COMPLETED,
    TERMINAL_FAILED: OpsMetric.PHONEPE_RECONCILE_TERMINAL_FAILED,
    STILL_PENDING: OpsMetric.PHONEPE_RECONCILE_STILL_PENDING,
    TRANSIENT_ERROR: OpsMetric.PHONEPE_RECONCILE_TRANSIENT,
  };
  const metric = map[outcome];
  if (metric) incrementOpsMetric(metric);
}

export function recordPhonePeRefundOutcome(outcome) {
  const map = {
    COMPLETED: OpsMetric.PHONEPE_REFUND_COMPLETED,
    FAILED: OpsMetric.PHONEPE_REFUND_FAILED,
    ACCEPTED: OpsMetric.PHONEPE_REFUND_ACCEPTED,
  };
  const metric = map[outcome];
  if (metric) incrementOpsMetric(metric);
}

export function recordPhonePeWebhookOutOfOrder() {
  incrementOpsMetric(OpsMetric.PHONEPE_WEBHOOK_OUT_OF_ORDER);
}

export function recordPhonePeDriftRepaired() {
  incrementOpsMetric(OpsMetric.PHONEPE_RECONCILE_DRIFT_REPAIRED);
}

export function getOpsMetricsSnapshot() {
  const durations = {};
  for (const name of Object.keys(durationTotals)) {
    const count = durationCounts[name] ?? 0;
    durations[name] = {
      totalMs: durationTotals[name],
      count,
      avgMs: count ? Math.round(durationTotals[name] / count) : 0,
    };
  }
  return {
    counters: { ...counters },
    durations,
    lastRuns: { ...lastRuns },
  };
}

export function resetOpsMetricsForTests() {
  for (const key of Object.keys(counters)) delete counters[key];
  for (const key of Object.keys(durationTotals)) delete durationTotals[key];
  for (const key of Object.keys(durationCounts)) delete durationCounts[key];
  for (const key of Object.keys(lastRuns)) delete lastRuns[key];
}
