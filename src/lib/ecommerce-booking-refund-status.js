import { EcommerceBooking, EcommercePaymentExceptionRefund } from "../models/index.js";
import { EcommerceBookingRefundStatus } from "../constants/enums.js";

const OPEN = ["ASSIGNED", "INITIATED", "PROVIDER_PENDING"];

/**
 * Recompute a booking's refundStatus from its refund rows: a failed refund makes it FAILED, any
 * refund still open (assigned, being sent, or waiting on the provider) keeps it PENDING, and when
 * every refund is settled it is SETTLED. A booking with no refund rows is left alone.
 *
 * Call it whenever a booking-owned refund row appears or changes state: when it is reserved
 * (including a late capture on a cancelled or expired booking), when staff retry it, and when it
 * settles or fails. The status comes from the rows, not from the previous status, so it can never
 * disagree with them.
 *
 * Serializes on the booking row BEFORE reading the refunds. Two refunds of one booking changing in
 * parallel would otherwise each count the other as still open (neither has committed). This write
 * conflicts with the other's: the loser's transaction is retried and then reads a snapshot that
 * includes the winner's commit.
 */
export async function recomputeBookingRefundStatusFor({ tenantId, bookingId, session }) {
  if (!bookingId) return null;
  const locked = await EcommerceBooking.updateOne({ _id: bookingId, tenantId }, { $inc: { refundSettlementSeq: 1 } }, { session });
  if (!locked.matchedCount) return null;
  const rows = await EcommercePaymentExceptionRefund.find({ tenantId, bookingId }).select("status").session(session).lean();
  if (!rows.length) return null;
  const statuses = rows.map((row) => row.status);
  const next = statuses.includes("FAILED")
    ? EcommerceBookingRefundStatus.FAILED
    : statuses.some((status) => OPEN.includes(status))
      ? EcommerceBookingRefundStatus.PENDING
      : EcommerceBookingRefundStatus.SETTLED;
  await EcommerceBooking.updateOne({ _id: bookingId, tenantId }, { $set: { refundStatus: next } }, { session });
  return next;
}
