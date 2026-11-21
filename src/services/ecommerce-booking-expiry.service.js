import { withTransaction } from "../lib/transaction.js";
import { releaseBookingHolds } from "../lib/ecommerce-booking-stock.js";
import { reserveCaptureRefund } from "../lib/ecommerce-refund-allocator.js";
import { logger } from "../config/logger.js";
import { upsertOperationalAlert } from "../lib/operational-alert.js";
import {
  AlertType,
  EcommerceBookingRefundStatus,
  EcommerceBookingStatus,
  EcommerceOrderRefundSource,
  EcommercePaymentAttemptStatus,
} from "../constants/enums.js";
import { EcommerceBooking, EcommercePaymentAttempt } from "../models/index.js";
import { expireBookingPaymentAttempt } from "./ecommerce-booking-payment.service.js";

const OPEN = [
  EcommerceBookingStatus.PENDING_ADVANCE,
  EcommerceBookingStatus.CONFIRMED,
  EcommerceBookingStatus.BALANCE_PENDING,
];
const SETTLED_ATTEMPT = new Set(["EXPIRED", "NOT_ACTIVE", "NOT_FOUND"]);
const ALERT_AFTER_DEFERRALS = 3;
const RETRY_BASE_MS = 2 * 60_000;
const RETRY_MAX_MS = 60 * 60_000;
/** Exponential backoff for a booking expiry could not settle: 2, 4, 8 ... up to 60 minutes. */
export const expiryRetryDelayMs = (deferrals) => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(deferrals, 10));

async function deferExpiry({ tenantId, bookingId, at }) {
  const row = await EcommerceBooking.findOne({ _id: bookingId, tenantId }).select("expiryDeferrals bookingNumber pickupBranchId").lean();
  const n = row?.expiryDeferrals ?? 0;
  if (n + 1 >= ALERT_AFTER_DEFERRALS) {
    await upsertOperationalAlert({
      tenantId,
      type: AlertType.PAYMENT_REVIEW,
      entityId: bookingId,
      title: "Booking cannot be expired",
      message: "Expiry of this booking keeps failing, usually because the payment provider cannot confirm a payment. Check the booking's payment attempt with the provider.",
      branchId: row?.pickupBranchId ?? null,
      metadata: { bookingId, bookingNumber: row?.bookingNumber, deferrals: n + 1 },
    }).catch((error) => logger.error({ err: error, bookingId }, "Booking expiry alert failed"));
  }
  await EcommerceBooking.updateOne(
    { _id: bookingId, tenantId, status: { $in: OPEN } },
    { $set: { expiryRetryAt: new Date(at.getTime() + expiryRetryDelayMs(n)) }, $inc: { expiryDeferrals: 1 } },
  );
}
const isDue = (booking, at) => OPEN.includes(booking?.status) && booking.expiryAt && new Date(booking.expiryAt) <= at;

/**
 * Expire one booking whose deadline has passed.
 *
 * A payment attempt of the booking may have been paid at the provider without us knowing yet, so
 * every active attempt is put through the guarded attempt expiry first (it asks the provider). A
 * capture found that way is applied by the normal payment handlers and can confirm or convert the
 * booking, so the booking is re-read afterwards and expired only if it is still due. If any attempt
 * cannot be settled yet the booking is left alone and retried on the next run.
 *
 * The final step is one transaction: status change (guarded on status and version), hold release,
 * and a refund of the whole captured advance, keyed by a stable operation id so replays create
 * nothing new.
 */
export async function expireBooking({ tenantId, bookingId, at = new Date() }) {
  let booking = await EcommerceBooking.findOne({ _id: bookingId, tenantId }).lean();
  if (!booking) return { outcome: "NOT_FOUND" };
  if (!isDue(booking, at)) return { outcome: OPEN.includes(booking.status) ? "NOT_DUE" : "NOT_OPEN", status: booking.status };

  const active = await EcommercePaymentAttempt.find({
    tenantId, bookingId, status: { $in: [EcommercePaymentAttemptStatus.PENDING, EcommercePaymentAttemptStatus.INITIATED] },
  }).select("_id").lean();
  const unresolved = [];
  for (const { _id } of active) {
    const res = await expireBookingPaymentAttempt({ tenantId, attemptId: _id, at });
    if (!SETTLED_ATTEMPT.has(res.outcome) && res.outcome !== "SUCCESS" && res.outcome !== "ALREADY_SUCCESS") {
      unresolved.push({ attemptId: _id, outcome: res.outcome });
    }
  }
  if (unresolved.length) {
    await deferExpiry({ tenantId, bookingId, at });
    return { outcome: "DEFERRED", unresolved };
  }

  return withTransaction(async (session) => {
    booking = await EcommerceBooking.findOne({ _id: bookingId, tenantId }).session(session).lean();
    if (!booking) return { outcome: "NOT_FOUND" };
    if (!isDue(booking, at)) return { outcome: OPEN.includes(booking.status) ? "CHANGED_NOT_DUE" : "NOT_OPEN", status: booking.status };
    const captured = booking.advance?.capturedPaise ?? 0;
    const updated = await EcommerceBooking.findOneAndUpdate(
      { _id: bookingId, tenantId, status: booking.status, version: booking.version },
      {
        $set: {
          status: EcommerceBookingStatus.EXPIRED,
          expiredAt: at,
          expiryAt: null,
          expiryRetryAt: null,
          ...(captured ? { refundStatus: EcommerceBookingRefundStatus.PENDING } : {}),
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    ).lean();
    if (!updated) return { outcome: "CHANGED_CONCURRENTLY" };
    const { releasedCount } = await releaseBookingHolds({ tenantId, bookingId, session, at });
    let refunded = false;
    if (captured) {
      const { created } = await reserveCaptureRefund({
        tenantId,
        paymentAttemptId: booking.advance.attemptId,
        amountPaise: captured,
        operationId: `booking-expiry:${bookingId}`,
        refundSource: EcommerceOrderRefundSource.BOOKING_EXPIRY,
        session,
      });
      refunded = created;
    }
    return { outcome: "EXPIRED", releasedCount, refunded, previousStatus: booking.status };
  });
}

/** Scan open bookings past their deadline. One failing booking never blocks the rest. */
export async function runEcommerceBookingExpiry(at = new Date(), { limit = 100 } = {}) {
  // A booking that could not be settled is skipped until its retry time, so it cannot occupy the
  // batch on every run while newer bookings that can expire wait.
  const due = await EcommerceBooking.find({
    status: { $in: OPEN },
    expiryAt: { $lte: at },
    $or: [{ expiryRetryAt: null }, { expiryRetryAt: { $lte: at } }],
  })
    .sort({ expiryAt: 1 }).limit(limit).select("_id tenantId").lean();
  const counts = {};
  for (const row of due) {
    try {
      const { outcome } = await expireBooking({ tenantId: row.tenantId, bookingId: row._id, at });
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    } catch (error) {
      counts.ERROR = (counts.ERROR ?? 0) + 1;
      await deferExpiry({ tenantId: row.tenantId, bookingId: row._id, at }).catch(() => {});
      logger.error({ err: error, bookingId: row._id }, "Booking expiry failed");
    }
  }
  return { scanned: due.length, counts, at: at.toISOString() };
}
