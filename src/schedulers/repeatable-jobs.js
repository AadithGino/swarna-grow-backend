import { QueueKind, buildRepeatableJobTemplate } from "../lib/queue-retry-policy.js";

function job(queue, id, repeat, name, data = {}) {
  const template = buildRepeatableJobTemplate(name, data, queue);
  return { queue, id, repeat, name: template.name, data: template.data, opts: template.opts };
}

/** Repeatable job registrations (scheduler process). */
export const schedulerRepeatableJobs = [
  job(QueueKind.SCHEDULER, "maturity-daily", { pattern: "5 0 * * *", tz: "Asia/Kolkata" }, "maturity"),
  job(QueueKind.SCHEDULER, "due-installments-daily", { pattern: "8 0 * * *", tz: "Asia/Kolkata" }, "due-installments"),
  job(QueueKind.SCHEDULER, "overdue-daily", { pattern: "10 0 * * *", tz: "Asia/Kolkata" }, "overdue"),
  job(QueueKind.SCHEDULER, "payment-reminders-hourly", { pattern: "0 * * * *", tz: "Asia/Kolkata" }, "payment-reminders"),
  job(QueueKind.SCHEDULER, "expire-flexible-capacity", { pattern: "15 0 * * *", tz: "Asia/Kolkata" }, "expire-flexible-capacity"),
  job(QueueKind.SCHEDULER, "defaulting-daily", { pattern: "20 0 * * *", tz: "Asia/Kolkata" }, "defaulting"),
  job(QueueKind.SCHEDULER, "apply-flexible-locks-daily", { pattern: "25 0 * * *", tz: "Asia/Kolkata" }, "apply-flexible-locks"),
  job(QueueKind.SCHEDULER, "grievance-close-hourly", { pattern: "0 * * * *", tz: "Asia/Kolkata" }, "grievance-auto-close"),
  job(QueueKind.PAYMENTS, "expire-payments", { every: 60_000 }, "expire-payments"),
  job(QueueKind.PAYMENTS, "phonepe-reconcile", { every: 120_000 }, "phonepe-reconcile"),
  job(QueueKind.MAINTENANCE, "webhook-reclaim", { every: 60_000 }, "webhook-reclaim"),
  job(QueueKind.MAINTENANCE, "dispatch-reclaim", { every: 60_000 }, "dispatch-reclaim"),
  job(QueueKind.MAINTENANCE, "push-broadcast-recover", { every: 60_000 }, "push-broadcast-recover"),
  job(QueueKind.MAINTENANCE, "export-artifact-cleanup", { pattern: "30 2 * * *", tz: "Asia/Kolkata" }, "export-artifact-cleanup"),
  job(QueueKind.MAINTENANCE, "ecommerce-quote-expiry", { every: 60_000 }, "ecommerce-quote-expiry"),
  job(QueueKind.MAINTENANCE, "ecommerce-order-payment-expiry", { every: 60_000 }, "ecommerce-order-payment-expiry"),
  job(QueueKind.MAINTENANCE, "ecommerce-cod-acceptance-expiry", { every: 60_000 }, "ecommerce-cod-acceptance-expiry"),
  job(QueueKind.MAINTENANCE, "ecommerce-promotion-maintenance", { every: 60_000 }, "ecommerce-promotion-maintenance"),
  job(QueueKind.PAYMENTS, "ecommerce-payment-reconcile", { every: 120_000 }, "ecommerce-payment-reconcile"),
  job(QueueKind.SCHEDULER, "gateway-settlement-daily", { pattern: "35 0 * * *", tz: "Asia/Kolkata" }, "gateway-settlement"),
];
