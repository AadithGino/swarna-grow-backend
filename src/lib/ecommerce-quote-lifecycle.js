import { EcommerceQuoteStatus } from "../constants/enums.js";
import { EcommercePriceQuote, EcommerceStockReservation } from "../models/index.js";

const UNOWNED_ORDER = [{ orderId: null }, { orderId: { $exists: false } }, { orderId: "" }];

/**
 * Release active quote-scoped reservations (not transferred to an order).
 */
export async function releaseQuoteReservationsOnce(tenantId, quoteId, session, at = new Date()) {
  await EcommerceStockReservation.updateMany(
    {
      tenantId,
      quoteId,
      releasedAt: null,
      $or: UNOWNED_ORDER,
    },
    { $set: { releasedAt: at } },
    { session },
  );
}

export async function transferQuoteReservationsToOrder({
  tenantId,
  quoteId,
  orderId,
  session,
  expiresAt,
}) {
  await EcommerceStockReservation.updateMany(
    {
      tenantId,
      quoteId,
      releasedAt: null,
      $or: UNOWNED_ORDER,
    },
    {
      $set: {
        orderId,
        expiresAt,
      },
    },
    { session },
  );
}

/**
 * Transition ACTIVE → EXPIRED and release quote-owned stock.
 */
export async function expireActiveQuoteRow(quoteId, tenantId, session, at = new Date()) {
  const updated = await EcommercePriceQuote.findOneAndUpdate(
    {
      _id: quoteId,
      tenantId,
      status: EcommerceQuoteStatus.ACTIVE,
    },
    {
      $set: { status: EcommerceQuoteStatus.EXPIRED },
    },
    { session, new: true },
  );
  if (!updated) return null;
  await releaseQuoteReservationsOnce(tenantId, quoteId, session, at);
  return updated;
}

export async function cancelActiveQuoteRow(quoteId, tenantId, session, at = new Date()) {
  const updated = await EcommercePriceQuote.findOneAndUpdate(
    {
      _id: quoteId,
      tenantId,
      status: EcommerceQuoteStatus.ACTIVE,
    },
    {
      $set: { status: EcommerceQuoteStatus.CANCELLED },
      $inc: { version: 1 },
    },
    { session, new: true },
  );
  if (!updated) return null;
  await releaseQuoteReservationsOnce(tenantId, quoteId, session, at);
  return updated;
}

export async function consumeActiveQuoteRow({
  quoteId,
  tenantId,
  customerId,
  orderId,
  session,
  at = new Date(),
}) {
  const updated = await EcommercePriceQuote.findOneAndUpdate(
    {
      _id: quoteId,
      tenantId,
      customerId,
      status: EcommerceQuoteStatus.ACTIVE,
      expiresAt: { $gt: at },
    },
    {
      $set: { status: EcommerceQuoteStatus.CONSUMED, orderId },
      $inc: { version: 1 },
    },
    { session, new: true },
  );
  return updated;
}

export async function expireQuoteByTimeIfActive(row, session, at = new Date()) {
  if (!row || row.status !== EcommerceQuoteStatus.ACTIVE) return row;
  if (new Date(row.expiresAt) > at) return row;
  const updated = await expireActiveQuoteRow(row._id, row.tenantId, session, at);
  return updated ?? { ...row, status: EcommerceQuoteStatus.EXPIRED };
}
