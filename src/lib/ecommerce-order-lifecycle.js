import {
  EcommerceOrderStatus,
  EcommerceStockPolicy,
  EcommerceStockReleaseReason,
} from "../constants/enums.js";
import { AppError } from "./app-error.js";
import { assertEcommerceOrderTransition } from "./ecommerce-order-transitions.js";
import { orderPaymentExpiryBlockedByInFlight } from "./ecommerce-payment-in-flight.js";
import {
  EcommerceInventory,
  EcommerceOrder,
  EcommerceStockReservation,
} from "../models/index.js";

/** Deduct on-hand stock and release reservation rows after verified payment (once). */
export async function consumeOrderStockReservationsOnce({
  tenantId,
  orderId,
  session,
  at = new Date(),
}) {
  const reservations = await EcommerceStockReservation.find({
    tenantId,
    orderId,
    releasedAt: null,
  })
    .session(session)
    .lean();
  const sorted = [...reservations].sort((a, b) =>
    String(a.productId).localeCompare(String(b.productId)),
  );
  for (const row of sorted) {
    const inv = await EcommerceInventory.findOne({ tenantId, productId: row.productId }).session(
      session,
    );
    if (!inv || inv.stockPolicy === EcommerceStockPolicy.MADE_TO_ORDER) continue;
    const qty = Number(row.quantity ?? 0);
    const updated = await EcommerceInventory.findOneAndUpdate(
      {
        _id: inv._id,
        tenantId,
        version: inv.version,
        quantityOnHand: { $gte: qty },
      },
      { $inc: { quantityOnHand: -qty, version: 1 } },
      { session, new: true },
    );
    if (!updated) {
      throw new AppError(
        "STOCK_CONSUME_FAILED",
        "Could not consume inventory for a paid order.",
        409,
        { orderId, productId: row.productId },
      );
    }
  }
  await EcommerceStockReservation.updateMany(
    { tenantId, orderId, releasedAt: null },
    { $set: { releasedAt: at } },
    { session },
  );
}

export async function releaseOrderReservationsOnce({
  tenantId,
  orderId,
  session,
  at = new Date(),
}) {
  await EcommerceStockReservation.updateMany(
    {
      tenantId,
      orderId,
      releasedAt: null,
    },
    { $set: { releasedAt: at } },
    { session },
  );
}

export async function expirePendingPaymentOrderRow({
  orderId,
  tenantId,
  session,
  at = new Date(),
}) {
  const current = await EcommerceOrder.findOne({ _id: orderId, tenantId }).session(session);
  if (!current || current.status !== EcommerceOrderStatus.PENDING_PAYMENT) return null;
  if (current.expiresAt && new Date(current.expiresAt) > at) return null;
  if (await orderPaymentExpiryBlockedByInFlight(current.toObject(), at, session)) return null;

  const updated = await EcommerceOrder.findOneAndUpdate(
    {
      _id: orderId,
      tenantId,
      status: EcommerceOrderStatus.PENDING_PAYMENT,
      expiresAt: { $lte: at },
    },
    {
      $set: {
        status: EcommerceOrderStatus.PAYMENT_EXPIRED,
        stockReleaseReason: EcommerceStockReleaseReason.PAYMENT_WINDOW_EXPIRED,
        stockReleasedAt: at,
      },
      $inc: { version: 1 },
    },
    { session, new: true },
  );
  if (!updated) return null;
  await releaseOrderReservationsOnce({ tenantId, orderId, session, at });
  return updated;
}

export async function cancelPendingPaymentOrderRow({
  orderId,
  tenantId,
  customerId,
  session,
  at = new Date(),
}) {
  const row = await EcommerceOrder.findOne({
    _id: orderId,
    tenantId,
    customerId,
  }).session(session);
  if (!row) return { kind: "NOT_FOUND" };
  if (row.status !== EcommerceOrderStatus.PENDING_PAYMENT) {
    return { kind: "NOT_CANCELLABLE", status: row.status };
  }
  assertEcommerceOrderTransition(
    "CUSTOMER",
    row.status,
    EcommerceOrderStatus.CANCELLED,
  );
  const updated = await EcommerceOrder.findOneAndUpdate(
    {
      _id: orderId,
      tenantId,
      customerId,
      status: EcommerceOrderStatus.PENDING_PAYMENT,
    },
    {
      $set: {
        status: EcommerceOrderStatus.CANCELLED,
        stockReleaseReason: EcommerceStockReleaseReason.CUSTOMER_CANCEL,
        stockReleasedAt: at,
      },
      $inc: { version: 1 },
    },
    { session, new: true },
  );
  if (!updated) return { kind: "RACE" };
  await releaseOrderReservationsOnce({ tenantId, orderId, session, at });
  return { kind: "OK", order: updated };
}
