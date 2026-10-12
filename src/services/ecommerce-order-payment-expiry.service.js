import { env } from "../config/env.js";
import { withTransaction } from "../lib/transaction.js";
import { expirePendingPaymentOrderRow } from "../lib/ecommerce-order-lifecycle.js";
import {
  ECOMMERCE_OUTBOX_TOPICS,
  enqueueEcommerceOutboxEvent,
} from "../lib/ecommerce-commerce-outbox.js";
import { EcommerceOrderEventType, EcommerceOrderStatus } from "../constants/enums.js";
import { EcommerceOrder, EcommerceOrderEvent } from "../models/index.js";
import { createId } from "../lib/ids.js";
import { logger } from "../config/logger.js";

function batchSize() {
  return env.ECOMMERCE_ORDER_PAYMENT_EXPIRY_BATCH_SIZE ?? 100;
}

function maxBatchesPerRun() {
  return env.ECOMMERCE_ORDER_PAYMENT_EXPIRY_MAX_BATCHES ?? 20;
}

/**
 * Idempotent sweep: PENDING_PAYMENT past expiresAt → PAYMENT_EXPIRED + release stock once.
 */
export async function runEcommerceOrderPaymentExpiry(at = new Date()) {
  let totalExpired = 0;
  for (let batch = 0; batch < maxBatchesPerRun(); batch += 1) {
    const due = await EcommerceOrder.find({
      status: EcommerceOrderStatus.PENDING_PAYMENT,
      expiresAt: { $lte: at },
    })
      .sort({ expiresAt: 1 })
      .limit(batchSize())
      .select("_id tenantId")
      .lean();
    if (!due.length) break;
    for (const row of due) {
      try {
        await withTransaction(async (session) => {
          const expired = await expirePendingPaymentOrderRow({
            orderId: row._id,
            tenantId: row.tenantId,
            session,
            at,
          });
          if (!expired) return;
          totalExpired += 1;
          await EcommerceOrderEvent.create(
            [
              {
                _id: createId("eoev"),
                tenantId: row.tenantId,
                orderId: row._id,
                type: EcommerceOrderEventType.PAYMENT_EXPIRED,
                actorType: "SYSTEM",
                payload: { at: at.toISOString() },
              },
            ],
            { session },
          );
          await enqueueEcommerceOutboxEvent({
            tenantId: row.tenantId,
            topic: ECOMMERCE_OUTBOX_TOPICS.PAYMENT_EXPIRED,
            key: `${row._id}:expired`,
            payload: { orderId: row._id },
            session,
          });
        });
      } catch (err) {
        logger.warn(
          { err, orderId: row._id, tenantId: row.tenantId },
          "ecommerce order payment expiry batch item failed",
        );
      }
    }
    if (due.length < batchSize()) break;
  }
  return { expiredOrders: totalExpired, at: at.toISOString() };
}
