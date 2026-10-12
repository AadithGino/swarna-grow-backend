import { EcommerceStockPolicy } from "../constants/enums.js";
import { AppError } from "./app-error.js";
import {
  EcommerceInventoryAdjustment,
  EcommerceOrder,
  EcommerceStockReservation,
} from "../models/index.js";

/**
 * Append or merge durable per-line consumption on the order (exactly once per productId).
 */
export async function appendOrderStockConsumptionEvidence({
  tenantId,
  orderId,
  productId,
  quantityDeducted,
  inventoryId,
  stockPolicyAtConsumption,
  session,
  at = new Date(),
}) {
  const qty = Math.max(0, Number(quantityDeducted ?? 0));
  const order = await EcommerceOrder.findOne({ _id: orderId, tenantId }).session(session);
  if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);

  const existing = (order.stockConsumptionEvidence ?? []).find((row) => row.productId === productId);
  if (existing) {
    if (Number(existing.quantityDeducted ?? 0) !== qty) {
      throw new AppError(
        "STOCK_CONSUMPTION_EVIDENCE_CONFLICT",
        "Order stock consumption evidence already recorded with a different quantity.",
        409,
        { orderId, productId },
      );
    }
    return existing;
  }

  const entry = {
    productId,
    quantityDeducted: qty,
    inventoryId: inventoryId ?? null,
    stockPolicyAtConsumption,
    consumedAt: at,
  };
  await EcommerceOrder.findOneAndUpdate(
    { _id: orderId, tenantId },
    { $push: { stockConsumptionEvidence: entry }, $inc: { version: 1 } },
    { session },
  );
  return entry;
}

async function legacyInferFromAdjustments(order, session) {
  const lines = [];
  let uncertain = false;
  const orderRef = String(order.orderNumber ?? order._id ?? "");
  for (const line of order.lines ?? []) {
    const productId = line.productId;
    if (!productId) continue;
    if (!orderRef) {
      uncertain = true;
      continue;
    }
    const adj = await EcommerceInventoryAdjustment.find({
      tenantId: order.tenantId,
      productId,
      deltaQuantity: { $lt: 0 },
      reason: { $regex: orderRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") },
    })
      .sort({ createdAt: -1 })
      .limit(1)
      .session(session)
      .lean();
    if (adj.length) {
      lines.push({
        productId,
        quantityDeducted: Math.abs(Number(adj[0].deltaQuantity ?? 0)),
        inventoryId: adj[0].inventoryId ?? null,
        stockPolicyAtConsumption: EcommerceStockPolicy.QUANTITY_TRACKED,
        legacy: true,
      });
    } else if (order.stockConsumedAt) {
      uncertain = true;
    }
  }
  return { lines, uncertain };
}

async function legacyInferFromReservations(order, session) {
  const reservations = await EcommerceStockReservation.find({
    tenantId: order.tenantId,
    orderId: order._id,
    releasedAt: { $ne: null },
  })
    .session(session)
    .lean();
  if (!reservations.length) {
    return { lines: [], uncertain: Boolean(order.stockConsumedAt) };
  }
  const byProduct = new Map();
  for (const row of reservations) {
    byProduct.set(row.productId, (byProduct.get(row.productId) ?? 0) + Number(row.quantity ?? 0));
  }
  const lines = [];
  for (const [productId, qty] of byProduct) {
    lines.push({
      productId,
      quantityDeducted: qty,
      inventoryId: null,
      stockPolicyAtConsumption: EcommerceStockPolicy.QUANTITY_TRACKED,
      legacy: true,
      reservationDerived: true,
    });
  }
  return { lines, uncertain: false };
}

/**
 * Lines that may be restocked on cancellation (quantityDeducted > 0 only).
 */
export async function resolveOrderStockConsumptionEvidence(order, session) {
  const evidence = order.stockConsumptionEvidence ?? [];
  if (evidence.length) {
    return {
      lines: evidence.map((row) => ({
        productId: row.productId,
        quantityDeducted: Number(row.quantityDeducted ?? 0),
        inventoryId: row.inventoryId ?? null,
        stockPolicyAtConsumption: row.stockPolicyAtConsumption,
        legacy: false,
      })),
      uncertain: false,
    };
  }

  if (!order.stockConsumedAt && !order.paidAt) {
    return { lines: [], uncertain: false };
  }

  const fromAdj = await legacyInferFromAdjustments(order, session);
  if (fromAdj.lines.length) {
    return fromAdj;
  }

  if (order.stockConsumedAt) {
    const fromRes = await legacyInferFromReservations(order, session);
    if (fromRes.lines.length) {
      return fromRes;
    }
    return { lines: [], uncertain: true };
  }

  return { lines: [], uncertain: false };
}

export async function orderCancellationStockDispositionRequired(order, session) {
  if (order.stockRestockedAt || order.stockExceptionRecordedAt) {
    return false;
  }
  if (order.stockReleasedAt && !order.stockConsumedAt && !order.paidAt) {
    return false;
  }
  const { lines, uncertain } = await resolveOrderStockConsumptionEvidence(order, session);
  if (lines.some((row) => row.quantityDeducted > 0)) {
    return true;
  }
  if (uncertain) {
    return true;
  }
  return false;
}

export function restockLinesFromEvidence(consumption) {
  return consumption.lines.filter((row) => row.quantityDeducted > 0);
}
