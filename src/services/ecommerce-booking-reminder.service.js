import { logger } from "../config/logger.js";
import { EcommerceBookingRefundStatus, EcommerceBookingStatus, MessageType } from "../constants/enums.js";
import { queueEcommerceCustomerNotice } from "../lib/ecommerce-outbox-processor.js";
import { moneyRef } from "../lib/money.js";
import { EcommerceBooking } from "../models/index.js";

/**
 * Customer notices for advance bookings. Each notice is keyed by booking and event, and
 * queueEcommerceCustomerNotice skips a key it has already sent, so the job can overlap itself, rerun
 * after a crash, or be late without sending twice. The job finds work by looking at booking state,
 * not at transitions, so a missed run is made up on the next one (within each notice's window).
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const ADVANCE_REMINDER_LEAD_MS = 10 * MIN;
const RATE_PROTECTION_LEAD_MS = 24 * HOUR;
const RECENT_TERMINAL_MS = 3 * 24 * HOUR;
const OPEN_AFTER_ADVANCE = [EcommerceBookingStatus.CONFIRMED, EcommerceBookingStatus.BALANCE_PENDING];

const deepLink = (booking) => `/shop/booking/${booking._id}`;
const rupees = (paise) => moneyRef(paise).amountDisplay;

function hoursLabel(ms) {
  const hours = Math.max(1, Math.round(ms / HOUR));
  return hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * The reminder thresholds (hours before the balance is due) the policy asks for. Only the smallest
 * threshold already crossed is used, so a late run sends one notice, not one per missed threshold.
 */
export function dueReminderHour(thresholdsHours, remainingMs) {
  const crossed = (thresholdsHours ?? []).filter((h) => Number.isFinite(h) && h > 0 && remainingMs <= h * HOUR);
  return crossed.length ? Math.min(...crossed) : null;
}

const notice = (booking, key, title, body) => queueEcommerceCustomerNotice({
  tenantId: booking.tenantId,
  branchId: booking.pickupBranchId,
  customerId: booking.customerId,
  type: MessageType.ECOMMERCE_BOOKING_UPDATE,
  inboxEventKey: `ecommerce.booking.${key}:${booking._id}`,
  booking,
  title,
  body,
  deepLink: deepLink(booking),
});

async function eachNotice(rows, build, counts, label) {
  for (const booking of rows) {
    try {
      const built = build(booking);
      if (!built) continue;
      const result = await notice(booking, built.key, built.title, built.body);
      counts[`${label}:${result.outcome}`] = (counts[`${label}:${result.outcome}`] ?? 0) + 1;
    } catch (error) {
      counts[`${label}:ERROR`] = (counts[`${label}:ERROR`] ?? 0) + 1;
      logger.error({ err: error, bookingId: booking._id, notice: label }, "Booking notice failed");
    }
  }
}

export async function runEcommerceBookingReminders(at = new Date(), { limit = 200 } = {}) {
  const counts = {};
  const now = at.getTime();

  const advanceDue = await EcommerceBooking.find({
    status: EcommerceBookingStatus.PENDING_ADVANCE,
    advanceDueAt: { $gt: at, $lte: new Date(now + ADVANCE_REMINDER_LEAD_MS) },
  }).sort({ advanceDueAt: 1 }).limit(limit).lean();
  await eachNotice(advanceDue, (b) => ({
    key: "advance-due",
    title: "Pay your booking advance",
    body: `Your held ornament ${b.productName} will be released in a few minutes unless the advance of ${rupees(b.advance.requiredPaise)} is paid. Pay now to keep it.`,
  }), counts, "advance-due");

  // Look ahead as far as the largest threshold any policy could ask for.
  const balanceCandidates = await EcommerceBooking.find({
    status: { $in: OPEN_AFTER_ADVANCE },
    balanceDueAt: { $gt: at, $lte: new Date(now + 30 * 24 * HOUR) },
    "policy.snapshot.reminderHoursBeforeDue.0": { $exists: true },
  }).sort({ balanceDueAt: 1 }).limit(limit).lean();
  await eachNotice(balanceCandidates, (b) => {
    const remaining = new Date(b.balanceDueAt).getTime() - now;
    const hour = dueReminderHour(b.policy?.snapshot?.reminderHoursBeforeDue, remaining);
    if (hour == null) return null;
    const amount = b.finalBilling?.balancePaise != null ? ` The balance is ${rupees(b.finalBilling.balancePaise)}.` : "";
    return {
      key: `balance-due:${hour}`,
      title: "Balance due for your booking",
      body: `Your booking ${b.bookingNumber} for ${b.productName} must be completed within ${hoursLabel(remaining)}.${amount} After that the booking expires and the advance is refunded.`,
    };
  }, counts, "balance-due");

  const rateEnding = await EcommerceBooking.find({
    status: { $in: OPEN_AFTER_ADVANCE },
    "bookedRate.protectedUntil": { $gt: at, $lte: new Date(now + RATE_PROTECTION_LEAD_MS) },
  }).sort({ "bookedRate.protectedUntil": 1 }).limit(limit).lean();
  await eachNotice(rateEnding, (b) => ({
    key: "rate-protection-ending",
    title: "Your booked gold rate is ending soon",
    body: `The gold rate locked for booking ${b.bookingNumber} is protected for about ${hoursLabel(new Date(b.bookedRate.protectedUntil).getTime() - now)} more. After that the final price follows your booking terms.`,
  }), counts, "rate-protection-ending");

  const since = new Date(now - RECENT_TERMINAL_MS);
  const expired = await EcommerceBooking.find({
    status: EcommerceBookingStatus.EXPIRED,
    updatedAt: { $gte: since },
  }).sort({ updatedAt: -1 }).limit(limit).lean();
  await eachNotice(expired, (b) => ({
    key: "expired",
    title: "Booking expired",
    body: b.advance?.capturedPaise > 0
      ? `Your booking ${b.bookingNumber} expired. Your advance of ${rupees(b.advance.capturedPaise)} is being refunded.`
      : `Your booking ${b.bookingNumber} expired and the ornament is available again.`,
  }), counts, "expired");

  const refunded = await EcommerceBooking.find({
    refundStatus: EcommerceBookingRefundStatus.SETTLED,
    updatedAt: { $gte: since },
  }).sort({ updatedAt: -1 }).limit(limit).lean();
  await eachNotice(refunded, (b) => ({
    key: "refund-settled",
    title: "Booking refund completed",
    body: `Your refund for booking ${b.bookingNumber} has been completed. It can take a few days to show in your account.`,
  }), counts, "refund-settled");

  return { counts, at: at.toISOString() };
}
