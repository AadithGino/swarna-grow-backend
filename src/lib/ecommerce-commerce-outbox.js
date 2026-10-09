import { JobStatus } from "../constants/enums.js";
import { OutboxEvent } from "../models/index.js";

/** Idempotent tenant-scoped outbox enqueue (same topic+key while QUEUED skips duplicate). */
export async function enqueueEcommerceOutboxEvent({
  tenantId,
  topic,
  key,
  payload,
  session,
}) {
  const existing = await OutboxEvent.findOne({
    tenantId,
    topic,
    key,
    status: { $in: [JobStatus.QUEUED, JobStatus.PROCESSING] },
  }).session(session);
  if (existing) return existing._id;

  const row = (
    await OutboxEvent.create(
      [
        {
          tenantId,
          topic,
          key,
          payload: payload ?? {},
          status: JobStatus.QUEUED,
          availableAt: new Date(),
        },
      ],
      { session },
    )
  )[0];
  return row._id;
}

export const ECOMMERCE_OUTBOX_TOPICS = Object.freeze({
  PAYMENT_SUCCEEDED: "ecommerce.payment.succeeded",
  PAYMENT_FAILED: "ecommerce.payment.failed",
  PAYMENT_EXPIRED: "ecommerce.payment.expired",
  REFUND_COMPLETED: "ecommerce.refund.completed",
  FULFILMENT_MILESTONE: "ecommerce.fulfilment.milestone",
});
