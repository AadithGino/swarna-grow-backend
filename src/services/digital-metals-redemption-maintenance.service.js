import { withTransaction } from "../lib/transaction.js";
import { DigitalMetalRedemptionOrder } from "../models/index.js";
import { releaseReservation } from "./digital-metals-ledger.service.js";

const RELEASABLE = new Set(["CHARGE_PENDING"]);

export async function expireStaleRedemptionOrdersForTenant(tenantId, orderId = null) {
  const now = new Date();
  const filter = {
    tenantId,
    status: { $in: [...RELEASABLE] },
    chargePaymentExpiresAt: { $lt: now },
  };
  if (orderId) filter._id = orderId;
  const stale = await DigitalMetalRedemptionOrder.find(filter).limit(20).lean();
  for (const order of stale) {
    await withTransaction(async (session) => {
      const locked = await DigitalMetalRedemptionOrder.findOne({
        _id: order._id,
        tenantId,
        status: { $in: [...RELEASABLE] },
      }).session(session);
      if (!locked) return;
      const reserveKey = `${locked.idempotencyKey}:reserve`;
      await releaseReservation(session, tenantId, reserveKey, `redemption-expire:${locked._id}`);
      locked.status = "EXPIRED";
      await locked.save({ session });
    });
  }
}
