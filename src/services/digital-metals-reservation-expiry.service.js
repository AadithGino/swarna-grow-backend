import { DigitalMetalSellOrder, DigitalMetalRedemptionOrder } from "../models/index.js";
import { runRotatingMaintenanceScan } from "../lib/maintenance-scan-cursor.js";
import { expireAndReleaseSellOrder } from "./digital-metals-sell-maintenance.service.js";
import { expireAndReleaseRedemptionOrder } from "./digital-metals-redemption-maintenance.service.js";
import { logger } from "../config/logger.js";

export async function runReservationExpiryBatch({ kind, cursor = null, now = new Date(), limit = 50 }) {
  const sell = kind === "sell";
  const model = sell ? DigitalMetalSellOrder : DigitalMetalRedemptionOrder;
  const query = sell ? { $or: [{ status: "RESERVED", quoteExpiresAt: { $lte: now } }, { status: "PENDING_APPROVAL", approvalExpiresAt: { $lte: now } }] }
    : { status: "CHARGE_PENDING", chargePaymentExpiresAt: { $lt: now } };
  if (cursor) query._id = { $gt: cursor };
  const rows = await model.find(query).sort({ _id: 1 }).limit(Math.min(200, Math.max(1, limit))).lean();
  let processed = 0, failed = 0;
  for (const order of rows) {
    try {
      const result = sell ? await expireAndReleaseSellOrder(order) : await expireAndReleaseRedemptionOrder(order, now);
      if (result.outcome === "EXPIRED") processed++;
    } catch (error) {
      failed++;
      logger.error({ orderId: order._id, kind, code: error.code, err: error.message }, "Reservation expiry needs review");
    }
  }
  return { processed, failed, scanned: rows.length, cursor: rows.at(-1)?._id ?? cursor, hasMore: rows.length === Math.min(200, Math.max(1, limit)) };
}

export async function runDigitalMetalReservationExpiry(now = new Date()) {
  for (const kind of ["sell", "redemption"]) {
    await runRotatingMaintenanceScan({ stream: `digital_metal_${kind}_expiry`, maxBatches: 4,
      runBatch: cursor => runReservationExpiryBatch({ kind, cursor, now }) });
  }
}
