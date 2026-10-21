import { createId } from "./ids.js";
import { DigitalMetalOutboxEvent } from "../models/index.js";

export const DIGITAL_METAL_OUTBOX_TOPICS = Object.freeze({
  PURCHASE_CREDITED: "DIGITAL_METAL_PURCHASE_CREDITED",
  PURCHASE_PAYMENT_FAILED: "DIGITAL_METAL_PURCHASE_PAYMENT_FAILED",
  PURCHASE_INVOICE_REQUEST: "DIGITAL_METAL_PURCHASE_INVOICE_REQUEST",
  DOCUMENT_ARTIFACT_REQUEST: "DIGITAL_METAL_DOCUMENT_ARTIFACT_REQUEST",
  SELL_EXECUTED: "DIGITAL_METAL_SELL_EXECUTED",
  PAYOUT_CUSTOMER_NOTICE: "DIGITAL_METAL_PAYOUT_CUSTOMER_NOTICE",
  REDEMPTION_CUSTOMER_NOTICE: "DIGITAL_METAL_REDEMPTION_CUSTOMER_NOTICE",
  DOCUMENT_READY: "DIGITAL_METAL_DOCUMENT_READY",
});

/** Topics that enqueue customer inbox/push via the shared messaging pipeline (Phase 10). */
export const DIGITAL_METAL_CUSTOMER_NOTICE_TOPICS = new Set([
  DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_CREDITED,
  DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_PAYMENT_FAILED,
  DIGITAL_METAL_OUTBOX_TOPICS.SELL_EXECUTED,
  DIGITAL_METAL_OUTBOX_TOPICS.PAYOUT_CUSTOMER_NOTICE,
  DIGITAL_METAL_OUTBOX_TOPICS.REDEMPTION_CUSTOMER_NOTICE,
  DIGITAL_METAL_OUTBOX_TOPICS.DOCUMENT_READY,
]);

function isDuplicateKeyError(err) {
  return err?.code === 11000;
}

export async function enqueueDigitalMetalOutboxEvent({
  tenantId,
  topic,
  key,
  payload,
  session,
}) {
  try {
    await DigitalMetalOutboxEvent.create(
      [
        {
          _id: createId("dmobx"),
          tenantId,
          topic,
          key,
          payload: payload ?? {},
          status: "PENDING",
        },
      ],
      session ? { session } : undefined,
    );
    return { enqueued: true };
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      return { enqueued: false, duplicate: true };
    }
    throw err;
  }
}
