import { env } from "../config/env.js";
import { withTransaction } from "../lib/transaction.js";
import { expireCodPendingAcceptanceOrderRow } from "../lib/ecommerce-order-lifecycle.js";
import { EcommerceOrderEventType, EcommerceOrderStatus } from "../constants/enums.js";
import { EcommerceOrder, EcommerceOrderEvent } from "../models/index.js";
import { createId } from "../lib/ids.js";
import { logger } from "../config/logger.js";

function batchSize() {
  return env.ECOMMERCE_COD_ACCEPTANCE_EXPIRY_BATCH_SIZE ?? 100;
}

function maxBatchesPerRun() {
  return env.ECOMMERCE_COD_ACCEPTANCE_EXPIRY_MAX_BATCHES ?? 20;
}

/** COD_PENDING_ACCEPTANCE past expiresAt → CANCELLED + release stock (never PAYMENT_EXPIRED). */
export async function runEcommerceCodAcceptanceExpiry(at = new Date()) {
  let totalExpired = 0;
  for (let batch = 0; batch < maxBatchesPerRun(); batch += 1) {
    const due = await EcommerceOrder.find({
      status: EcommerceOrderStatus.COD_PENDING_ACCEPTANCE,
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
          const expired = await expireCodPendingAcceptanceOrderRow({
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
                type: EcommerceOrderEventType.COD_ACCEPTANCE_EXPIRED,
                actorType: "SYSTEM",
                payload: { at: at.toISOString() },
              },
            ],
            { session },
          );
        });
      } catch (err) {
        logger.warn(
          { err, orderId: row._id, tenantId: row.tenantId },
          "ecommerce cod acceptance expiry batch item failed",
        );
      }
    }
    if (due.length < batchSize()) break;
  }
  return { expiredCodOrders: totalExpired, at: at.toISOString() };
}
