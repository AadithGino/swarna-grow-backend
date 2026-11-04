import { withTransaction } from "../lib/transaction.js";
import { DigitalMetalRedemptionOrder, DigitalMetalRedemptionPaymentAttempt } from "../models/index.js";
import { releaseReservation } from "./digital-metals-ledger.service.js";

export async function expireAndReleaseRedemptionOrder(order, now = new Date()) {
  return withTransaction(async session => {
    const locked = await DigitalMetalRedemptionOrder.findOne({ _id: order._id, tenantId: order.tenantId,
      status: "CHARGE_PENDING", chargePaymentExpiresAt: { $lt: now }, version: order.version }).session(session);
    if (!locked) return { outcome: "NOOP" };
    const uncertain = await DigitalMetalRedemptionPaymentAttempt.findOne({ tenantId: locked.tenantId, orderId: locked._id,
      status: { $nin: ["FAILED", "EXPIRED", "CANCELLED"] } }).session(session).lean();
    if (uncertain) return { outcome: "PAYMENT_UNRESOLVED" };
    await releaseReservation(session, locked.tenantId, `${locked.idempotencyKey}:reserve`, `redemption-expire:${locked._id}`);
    locked.status = "EXPIRED";
    locked.version = (locked.version ?? 1) + 1;
    await locked.save({ session });
    return { outcome: "EXPIRED" };
  });
}

export async function expireStaleRedemptionOrdersForTenant(tenantId, orderId = null) {
  const now = new Date();
  const stale = await DigitalMetalRedemptionOrder.find({ tenantId, status: "CHARGE_PENDING", chargePaymentExpiresAt: { $lt: now },
    ...(orderId ? { _id: orderId } : {}) }).limit(20).lean();
  for (const order of stale) await expireAndReleaseRedemptionOrder(order, now);
}
