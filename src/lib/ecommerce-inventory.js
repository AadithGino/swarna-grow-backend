import { EcommerceStockPolicy } from "../constants/enums.js";
import { AppError } from "./app-error.js";
import { EcommerceInventory, EcommerceStockReservation } from "../models/index.js";

const MAX_QTY = 1_000_000;

export function sanitizeInventoryQuantity(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new AppError("VALIDATION_FAILED", "Quantity must be a whole number.", 422);
  }
  if (n < 0 || n > MAX_QTY) {
    throw new AppError("VALIDATION_FAILED", "Quantity is out of allowed range.", 422);
  }
  return n;
}

export async function sumActiveReservations(tenantId, productId, session) {
  const now = new Date();
  const pipeline = [
    {
      $match: {
        tenantId,
        productId,
        releasedAt: null,
        expiresAt: { $gt: now },
      },
    },
    { $group: { _id: null, total: { $sum: "$quantity" } } },
  ];
  let agg = EcommerceStockReservation.aggregate(pipeline);
  if (session) agg = agg.session(session);
  const rows = await agg;
  return rows[0]?.total ?? 0;
}

export function computeAvailableQuantity(inventoryRow, activeReserved) {
  const policy = inventoryRow?.stockPolicy ?? EcommerceStockPolicy.MADE_TO_ORDER;
  if (policy === EcommerceStockPolicy.MADE_TO_ORDER) {
    return { policy, quantityOnHand: null, reserved: 0, available: null };
  }
  const onHand = sanitizeInventoryQuantity(inventoryRow?.quantityOnHand ?? 0);
  const reserved = sanitizeInventoryQuantity(activeReserved ?? 0);
  const available = onHand - reserved;
  if (available < 0) {
    throw new AppError(
      "INVENTORY_INCONSISTENT",
      "Reserved quantity exceeds on-hand stock.",
      409,
      { productId: inventoryRow?.productId, onHand, reserved },
    );
  }
  return { policy, quantityOnHand: onHand, reserved, available };
}

export async function loadInventoryAvailability(tenantId, productId, session) {
  const inv = await EcommerceInventory.findOne({ tenantId, productId })
    .session(session ?? null)
    .lean();
  const policy = inv?.stockPolicy ?? EcommerceStockPolicy.MADE_TO_ORDER;
  if (policy === EcommerceStockPolicy.MADE_TO_ORDER) {
    return {
      stockPolicy: policy,
      quantityOnHand: null,
      reservedQuantity: 0,
      availableQuantity: null,
      purchasable: true,
    };
  }
  const reserved = await sumActiveReservations(tenantId, productId, session);
  const { quantityOnHand, reserved: reservedQty, available } = computeAvailableQuantity(
    { ...inv, productId, stockPolicy: policy },
    reserved,
  );
  return {
    stockPolicy: policy,
    quantityOnHand,
    reservedQuantity: reservedQty,
    availableQuantity: available,
    purchasable: available > 0,
  };
}

export function mapPublicAvailability(availability) {
  if (availability.stockPolicy === EcommerceStockPolicy.MADE_TO_ORDER) {
    return {
      stockPolicy: availability.stockPolicy,
      availableQuantity: null,
      purchasable: true,
      label: "Made to order",
    };
  }
  return {
    stockPolicy: availability.stockPolicy,
    availableQuantity: availability.availableQuantity,
    purchasable: availability.purchasable,
    label:
      availability.availableQuantity > 0
        ? `${availability.availableQuantity} in stock`
        : "Out of stock",
  };
}
