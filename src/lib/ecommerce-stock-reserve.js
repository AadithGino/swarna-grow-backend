import { createId } from "./ids.js";
import { AppError } from "./app-error.js";
import { EcommerceStockPolicy } from "../constants/enums.js";
import {
  loadInventoryAvailability,
  sanitizeInventoryQuantity,
} from "./ecommerce-inventory.js";
import { releaseQuoteReservationsOnce } from "./ecommerce-quote-lifecycle.js";
import { EcommerceInventory, EcommerceStockReservation } from "../models/index.js";

export async function releaseExpiredStockReservations(tenantId, session, at = new Date()) {
  await EcommerceStockReservation.updateMany(
    {
      tenantId,
      releasedAt: null,
      expiresAt: { $lte: at },
      $or: [{ orderId: null }, { orderId: { $exists: false } }, { orderId: "" }],
    },
    { $set: { releasedAt: at } },
    { session },
  );
}

export { releaseQuoteReservationsOnce as releaseQuoteReservations };

/**
 * Atomically reserve all lines inside the caller transaction.
 * Sorted product locks prevent deadlocks; failure rolls back all reservation rows.
 */
export async function reserveStockForQuote({
  tenantId,
  quoteId,
  lines,
  expiresAt,
  session,
}) {
  await releaseExpiredStockReservations(tenantId, session);
  const sorted = [...lines].sort((a, b) => String(a.productId).localeCompare(String(b.productId)));
  const created = [];
  for (const { productId, quantity } of sorted) {
    const qty = sanitizeInventoryQuantity(quantity);
    const inv = await EcommerceInventory.findOne({ tenantId, productId }).session(session);
    const policy = inv?.stockPolicy ?? EcommerceStockPolicy.MADE_TO_ORDER;
    if (policy === EcommerceStockPolicy.MADE_TO_ORDER) continue;
    if (!inv) {
      throw new AppError(
        "INSUFFICIENT_STOCK",
        "Quantity-tracked inventory is not configured.",
        422,
        { productId },
      );
    }
    const locked = await EcommerceInventory.findOneAndUpdate(
      { _id: inv._id, tenantId, version: inv.version },
      { $inc: { version: 1 } },
      { session, new: true },
    );
    if (!locked) {
      throw new AppError(
        "INVENTORY_BUSY",
        "Stock changed while reserving. Retry.",
        409,
        { productId },
      );
    }
    const availability = await loadInventoryAvailability(tenantId, productId, session);
    if ((availability.availableQuantity ?? 0) < qty) {
      throw new AppError(
        "INSUFFICIENT_STOCK",
        "Not enough stock to reserve for this quote.",
        422,
        { productId, availableQuantity: availability.availableQuantity ?? 0, requested: qty },
      );
    }
    const row = (
      await EcommerceStockReservation.create(
        [
          {
            _id: createId("ersv"),
            tenantId,
            productId,
            quoteId,
            quantity: qty,
            expiresAt,
          },
        ],
        { session },
      )
    )[0];
    created.push(row._id);
  }
  return created;
}
