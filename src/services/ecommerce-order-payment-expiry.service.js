import { MaintenanceScanStream, runMaintenanceScanWithLocalFallback } from "../lib/maintenance-scan-cursor.js";
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

async function expirePaymentBatch(at, cursor, limit) {
  const due = await EcommerceOrder.find({
    status: EcommerceOrderStatus.PENDING_PAYMENT,
    expiresAt: { $lte: at },
    ...(cursor ? { _id: { $gt: cursor } } : {}),
  }).sort({ _id: 1 }).limit(limit).select("_id tenantId").lean();

  let processed = 0;
  let failed = 0;
  for (const row of due) {
    try {
      const committed = await withTransaction(async (session) => {
        const expired = await expirePendingPaymentOrderRow({ orderId: row._id, tenantId: row.tenantId, session, at });
        if (!expired) return false;
        await EcommerceOrderEvent.create([{
          _id: createId("eoev"), tenantId: row.tenantId, orderId: row._id,
          type: EcommerceOrderEventType.PAYMENT_EXPIRED, actorType: "SYSTEM", payload: { at: at.toISOString() },
        }], { session });
        await enqueueEcommerceOutboxEvent({
          tenantId: row.tenantId, topic: ECOMMERCE_OUTBOX_TOPICS.PAYMENT_EXPIRED, key: `${row._id}:expired`,
          payload: { orderId: row._id }, session,
        });
        return true;
      });
      if (committed) processed += 1;
    } catch (err) {
      failed += 1;
      logger.warn({ err, orderId: row._id, tenantId: row.tenantId }, "ecommerce order payment expiry batch item failed");
    }
  }
  return { processed, failed, scanned: due.length, cursor: due.at(-1)?._id ?? cursor, hasMore: due.length === limit };
}

/** Expire overdue orders and release their reserved stock in the same transaction. */
export async function runEcommerceOrderPaymentExpiry(at = new Date(), options = {}) {
  const { maxBatches = maxBatchesPerRun(), limit = batchSize() } = options;
  const { processed } = await runMaintenanceScanWithLocalFallback({
    stream: MaintenanceScanStream.ECOMMERCE_PAYMENT_EXPIRY,
    maxBatches,
    runBatch: (cursor) => expirePaymentBatch(at, cursor, limit),
  });
  return { expiredOrders: processed, at: at.toISOString() };
}
