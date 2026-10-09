import { env } from "../config/env.js";
import { withTransaction } from "../lib/transaction.js";
import { expireActiveQuoteRow } from "../lib/ecommerce-quote-lifecycle.js";
import { EcommerceQuoteStatus } from "../constants/enums.js";
import { EcommercePriceQuote } from "../models/index.js";
import { logger } from "../config/logger.js";

function batchSize() {
  return env.ECOMMERCE_QUOTE_EXPIRY_BATCH_SIZE ?? 100;
}

function maxBatchesPerRun() {
  return env.ECOMMERCE_QUOTE_EXPIRY_MAX_BATCHES ?? 20;
}

/**
 * Idempotent scheduled sweep: expire ACTIVE quotes past TTL and release reservations.
 */
export async function runEcommerceQuoteExpiry(at = new Date()) {
  let totalExpired = 0;
  for (let batch = 0; batch < maxBatchesPerRun(); batch += 1) {
    const due = await EcommercePriceQuote.find({
      status: EcommerceQuoteStatus.ACTIVE,
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
          const expired = await expireActiveQuoteRow(row._id, row.tenantId, session, at);
          if (expired) totalExpired += 1;
        });
      } catch (err) {
        logger.warn(
          { err, quoteId: row._id, tenantId: row.tenantId },
          "ecommerce quote expiry batch item failed",
        );
      }
    }
    if (due.length < batchSize()) break;
  }
  return { expiredQuotes: totalExpired, at: at.toISOString() };
}
