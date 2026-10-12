import {
  EcommerceCancellationStockDisposition,
  EcommerceStockReleaseReason,
} from "../constants/enums.js";
import { AppError } from "./app-error.js";
import { createId } from "./ids.js";
import {
  EcommerceInventory,
  EcommerceInventoryAdjustment,
  EcommerceOrder,
  EcommerceStockReservation,
} from "../models/index.js";
import {
  resolveOrderStockConsumptionEvidence,
  restockLinesFromEvidence,
} from "./ecommerce-order-stock-consumed-evidence.js";

/**
 * After paid/accepted orders: restock only when staff confirms physical availability.
 * Quantities come from order consumption evidence, not current SKU policy.
 */
export async function applyCancellationStockDispositionOnce({
  tenantId,
  orderId,
  disposition,
  actorUserId,
  idempotencyKey,
  session,
  at = new Date(),
}) {
  const order = await EcommerceOrder.findOne({ _id: orderId, tenantId }).session(session);
  if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);
  if (order.stockRestockedAt || order.stockExceptionRecordedAt) {
    return { kind: "ALREADY_APPLIED", order: order.toObject() };
  }

  const reservations = await EcommerceStockReservation.find({
    tenantId,
    orderId,
    releasedAt: { $ne: null },
  })
    .session(session)
    .lean();

  const consumption = await resolveOrderStockConsumptionEvidence(order.toObject(), session);
  const restockLines = restockLinesFromEvidence(consumption);

  if (disposition === EcommerceCancellationStockDisposition.RESTOCK_CONFIRMED) {
    if (consumption.uncertain && !restockLines.length) {
      throw new AppError(
        "STOCK_RESTOCK_UNCERTAIN",
        "Cannot confirm restock without durable consumption evidence. Use stock exception or resolve inventory first.",
        422,
        { orderId },
      );
    }
    const sorted = [...restockLines].sort((a, b) =>
      String(a.productId).localeCompare(String(b.productId)),
    );
    for (const line of sorted) {
      const qty = Number(line.quantityDeducted ?? 0);
      if (qty <= 0) continue;
      const inv = await EcommerceInventory.findOne({
        tenantId,
        productId: line.productId,
      }).session(session);
      if (!inv) {
        throw new AppError(
          "INVENTORY_NOT_FOUND",
          "Inventory row missing for a consumed SKU; cannot restock.",
          422,
          { productId: line.productId, orderId },
        );
      }
      const before = Number(inv.quantityOnHand ?? 0);
      const updated = await EcommerceInventory.findOneAndUpdate(
        { _id: inv._id, tenantId, version: inv.version },
        { $inc: { quantityOnHand: qty, version: 1 } },
        { session, new: true },
      );
      if (!updated) {
        throw new AppError(
          "STOCK_RESTOCK_FAILED",
          "Could not restock inventory for cancellation.",
          409,
          { productId: line.productId },
        );
      }
      await EcommerceInventoryAdjustment.create(
        [
          {
            _id: createId("einvadj"),
            tenantId,
            productId: line.productId,
            inventoryId: inv._id,
            deltaQuantity: qty,
            quantityOnHandBefore: before,
            quantityOnHandAfter: updated.quantityOnHand,
            reason: `Cancellation restock (order ${order.orderNumber})`,
            actorUserId,
          },
        ],
        { session },
      );
    }
    await EcommerceOrder.updateOne(
      { _id: orderId, tenantId },
      {
        $set: {
          stockRestockedAt: at,
          stockReleaseReason: EcommerceStockReleaseReason.CANCELLATION_RESTOCK,
          stockRestockIdempotencyKey: idempotencyKey ?? undefined,
        },
        $inc: { version: 1 },
      },
      { session },
    );
    return { kind: "RESTOCKED", reservationCount: reservations.length, restockLineCount: sorted.length };
  }

  if (disposition === EcommerceCancellationStockDisposition.STOCK_EXCEPTION) {
    await EcommerceOrder.updateOne(
      { _id: orderId, tenantId },
      {
        $set: {
          stockExceptionRecordedAt: at,
          stockReleaseReason: EcommerceStockReleaseReason.CANCELLATION_STOCK_EXCEPTION,
          stockRestockIdempotencyKey: idempotencyKey ?? undefined,
        },
        $inc: { version: 1 },
      },
      { session },
    );
    return { kind: "STOCK_EXCEPTION", reservationCount: reservations.length };
  }

  throw new AppError("VALIDATION", "Invalid stock disposition.", 422);
}

/** Restock delivered-order inventory after staff confirms physical return receipt. */
export async function applyReturnReceiptRestockOnce({
  tenantId,
  orderId,
  returnRequestId,
  actorUserId,
  session,
  at = new Date(),
}) {
  const order = await EcommerceOrder.findOne({ _id: orderId, tenantId }).session(session);
  if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);

  const consumption = await resolveOrderStockConsumptionEvidence(order.toObject(), session);
  const restockLines = restockLinesFromEvidence(consumption);
  if (consumption.uncertain && !restockLines.length) {
    throw new AppError(
      "STOCK_RESTOCK_UNCERTAIN",
      "Cannot restock without durable consumption evidence.",
      422,
      { orderId, returnRequestId },
    );
  }
  const sorted = [...restockLines].sort((a, b) =>
    String(a.productId).localeCompare(String(b.productId)),
  );
  for (const line of sorted) {
    const qty = Number(line.quantityDeducted ?? 0);
    if (qty <= 0) continue;
    const inv = await EcommerceInventory.findOne({ tenantId, productId: line.productId }).session(
      session,
    );
    if (!inv) {
      throw new AppError("INVENTORY_NOT_FOUND", "Inventory row missing for a consumed SKU.", 422, {
        productId: line.productId,
        orderId,
      });
    }
    const before = Number(inv.quantityOnHand ?? 0);
    const updated = await EcommerceInventory.findOneAndUpdate(
      { _id: inv._id, tenantId, version: inv.version },
      { $inc: { quantityOnHand: qty, version: 1 } },
      { session, new: true },
    );
    if (!updated) {
      throw new AppError("STOCK_RESTOCK_FAILED", "Could not restock inventory for return.", 409, {
        productId: line.productId,
      });
    }
    await EcommerceInventoryAdjustment.create(
      [
        {
          _id: createId("einvadj"),
          tenantId,
          productId: line.productId,
          inventoryId: inv._id,
          deltaQuantity: qty,
          quantityOnHandBefore: before,
          quantityOnHandAfter: updated.quantityOnHand,
          reason: `Return restock (order ${order.orderNumber}, request ${returnRequestId})`,
          actorUserId,
        },
      ],
      { session },
    );
  }
  return { restockLineCount: sorted.filter((l) => Number(l.quantityDeducted ?? 0) > 0).length, at };
}
