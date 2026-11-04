import { withTransaction } from "../lib/transaction.js";
import { DigitalMetalReservation, DigitalMetalSellOrder } from "../models/index.js";
import { releaseReservation } from "./digital-metals-ledger.service.js";

async function releaseSellReservationIfActive(session, tenantId, reserveKey, releaseKey) {
  const reservation = await DigitalMetalReservation.findOne({ tenantId, idempotencyKey: reserveKey })
    .session(session);
  if (!reservation) return;
  if (reservation.status === "RELEASED" || reservation.status === "COMMITTED") return;
  await releaseReservation(session, tenantId, reserveKey, releaseKey);
}

export async function expireStaleSellOrdersForTenant(tenantId, orderId = null) {
  const now = new Date();
  const orClauses = [
    { quoteExpiresAt: { $lte: now }, status: "RESERVED" },
    { approvalExpiresAt: { $lte: now }, status: "PENDING_APPROVAL" },
  ];
  const filter = { tenantId, status: { $in: ["RESERVED", "PENDING_APPROVAL"] }, $or: orClauses };
  if (orderId) filter._id = orderId;
  const rows = await DigitalMetalSellOrder.find(filter).limit(20).lean();
  const outcomes = [];
  for (const row of rows) {
    outcomes.push(await expireAndReleaseSellOrder(row));
  }
  return { scanned: rows.length, outcomes };
}

export async function expireSellOrderById(orderId, tenantId) {
  const order = await DigitalMetalSellOrder.findOne({ _id: orderId, tenantId }).lean();
  if (!order) return { outcome: "NOT_FOUND" };
  return expireAndReleaseSellOrder(order);
}

export async function cancelAndReleaseSellOrder(order) {
  if (!order || !["RESERVED", "PENDING_APPROVAL"].includes(order.status)) {
    return { outcome: "NOOP", orderId: order?._id };
  }
  return withTransaction(async (session) => {
    const locked = await DigitalMetalSellOrder.findOne({
      _id: order._id,
      tenantId: order.tenantId,
      status: { $in: ["RESERVED", "PENDING_APPROVAL"] },
    }).session(session);
    if (!locked) return { outcome: "NOOP", orderId: order._id };
    const reserveKey = `${locked.idempotencyKey}:reserve`;
    await releaseSellReservationIfActive(session, locked.tenantId, reserveKey, `sell-cancel:${locked._id}`);
    locked.status = "CANCELLED";
    await locked.save({ session });
    return { outcome: "CANCELLED", orderId: locked._id };
  });
}

export async function expireAndReleaseSellOrder(order) {
  if (!order || ["EXECUTED", "PAYABLE_OPEN", "CANCELLED", "EXPIRED"].includes(order.status)) {
    return { outcome: "NOOP", orderId: order?._id };
  }
  return withTransaction(async (session) => {
    const locked = await DigitalMetalSellOrder.findOne({
      _id: order._id,
      tenantId: order.tenantId,
      status: { $in: ["RESERVED", "PENDING_APPROVAL"] },
      version: order.version,
      $or: [{ status: "RESERVED", quoteExpiresAt: { $lte: new Date() } }, { status: "PENDING_APPROVAL", approvalExpiresAt: { $lte: new Date() } }],
    }).session(session);
    if (!locked) return { outcome: "NOOP", orderId: order._id };
    const reserveKey = `${locked.idempotencyKey}:reserve`;
    await releaseSellReservationIfActive(session, locked.tenantId, reserveKey, `sell-release:${locked._id}`);
    locked.status = "EXPIRED";
    await locked.save({ session });
    return { outcome: "EXPIRED", orderId: locked._id };
  });
}
