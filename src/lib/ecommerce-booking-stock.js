import { createId } from "./ids.js";
import { AppError } from "./app-error.js";
import { EcommerceStockPolicy } from "../constants/enums.js";
import { loadInventoryAvailability, sanitizeInventoryQuantity } from "./ecommerce-inventory.js";
import { releaseExpiredStockReservations } from "./ecommerce-stock-reserve.js";
import { EcommerceInventory, EcommerceStockReservation } from "../models/index.js";

/**
 * A stock reservation has one owner: a quote, an order, or a booking.
 *
 *  - quote   -> quoteId; becomes order-owned when the quote is consumed (transferQuoteReservationsToOrder)
 *  - booking -> bookingId; becomes order-owned at conversion (transferBookingHoldToOrder)
 *  - order   -> orderId; consumed on verified payment, released on expiry or cancellation
 *
 * A booking hold is NOT a time-boxed quote hold. It keeps counting against SKU availability until
 * the booking itself releases it (expiry, cancellation) or converts it to an order, even when
 * `expiresAt` has passed. The quote/order expiry sweeps never touch it.
 */
const UNOWNED_BY_ORDER = [{ orderId: null }, { orderId: { $exists: false } }, { orderId: "" }];

/** Matches one booking's active holds that have not been converted to an order. */
export function bookingHoldFilter(tenantId, bookingId) {
  if (typeof bookingId !== "string" || !bookingId) {
    throw new AppError("VALIDATION_FAILED", "bookingId is required.", 422);
  }
  return { tenantId, bookingId, releasedAt: null, $or: UNOWNED_BY_ORDER };
}

function bookingHoldError(code, message, details) {
  return new AppError(code, message, 422, details);
}

/**
 * Reserve one tracked SKU for a booking inside the caller transaction. Replaying the same
 * (bookingId, productId) returns the hold that already exists and writes nothing.
 * Locks the inventory row by bumping its version, as quote reservations do, so two bookings (or a
 * booking and a quote) racing for the last unit conflict and one retries against committed state.
 */
export async function reserveStockForBooking({
  tenantId,
  bookingId,
  productId,
  quantity = 1,
  holdExpiresAt,
  session,
}) {
  if (!bookingId) throw bookingHoldError("VALIDATION_FAILED", "bookingId is required.");
  if (!(holdExpiresAt instanceof Date) || Number.isNaN(holdExpiresAt.getTime())) {
    throw bookingHoldError("VALIDATION_FAILED", "holdExpiresAt is required.");
  }
  const qty = sanitizeInventoryQuantity(quantity);
  if (qty < 1) throw bookingHoldError("VALIDATION_FAILED", "Quantity must be at least 1.");

  await releaseExpiredStockReservations(tenantId, session);

  const inv = await EcommerceInventory.findOne({ tenantId, productId }).session(session);
  if (!inv || inv.stockPolicy !== EcommerceStockPolicy.QUANTITY_TRACKED) {
    throw bookingHoldError(
      "BOOKING_SKU_NOT_TRACKED",
      "Only quantity-tracked SKUs can be booked.",
      { productId },
    );
  }
  const locked = await EcommerceInventory.findOneAndUpdate(
    { _id: inv._id, tenantId, version: inv.version },
    { $inc: { version: 1 } },
    { session, new: true },
  );
  if (!locked) {
    throw new AppError("INVENTORY_BUSY", "Stock changed while reserving. Retry.", 409, { productId });
  }

  const existing = await EcommerceStockReservation.findOne({
    ...bookingHoldFilter(tenantId, bookingId), productId,
  }).session(session).lean();
  if (existing) {
    if (existing.quantity !== qty) {
      throw new AppError("BOOKING_HOLD_QUANTITY_CHANGED",
        "A hold for this booking already exists with a different quantity.", 409, { productId });
    }
    return { reservation: existing, created: false };
  }

  const availability = await loadInventoryAvailability(tenantId, productId, session);
  if ((availability.availableQuantity ?? 0) < qty) {
    throw bookingHoldError("INSUFFICIENT_STOCK", "Not enough stock to hold for this booking.", {
      productId, availableQuantity: availability.availableQuantity ?? 0, requested: qty,
    });
  }
  const [row] = await EcommerceStockReservation.create([{
    _id: createId("ersv"),
    tenantId,
    productId,
    bookingId,
    quantity: qty,
    expiresAt: holdExpiresAt,
  }], { session });
  return { reservation: row.toObject(), created: true };
}

/** Releases a booking's unconverted holds. Only the booking lifecycle (expiry, cancel) calls this. */
export async function releaseBookingHolds({ tenantId, bookingId, session, at = new Date() }) {
  const result = await EcommerceStockReservation.updateMany(
    bookingHoldFilter(tenantId, bookingId),
    { $set: { releasedAt: at } },
    { session },
  );
  return { releasedCount: result.modifiedCount ?? 0 };
}

/**
 * Hands a booking's hold to the order created at conversion. The row keeps its bookingId for
 * audit, takes the order's orderId and expiry, and from then on follows the ordinary order rules
 * (consumed on payment, released on order expiry or cancellation).
 */
export async function transferBookingHoldsToOrder({
  tenantId, bookingId, orderId, expiresAt, session,
}) {
  const result = await EcommerceStockReservation.updateMany(
    bookingHoldFilter(tenantId, bookingId),
    { $set: { orderId, expiresAt } },
    { session },
  );
  if (!result.modifiedCount) {
    throw new AppError("BOOKING_HOLD_MISSING",
      "The booking has no active stock hold to convert.", 409, { bookingId });
  }
  return { transferredCount: result.modifiedCount };
}
