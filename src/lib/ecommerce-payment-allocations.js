import { EcommercePaymentAttempt } from "../models/index.js";
import { EcommercePaymentPurpose } from "../constants/enums.js";
import { errors } from "./app-error.js";

/**
 * Payment rows written before bookings existed have no `purpose`; they are ordinary checkout.
 * Use this instead of reading `row.purpose` directly (lean reads do not apply schema defaults).
 */
export function resolvePaymentPurpose(row) {
  return row?.purpose ?? EcommercePaymentPurpose.ORDER_CHECKOUT;
}

/** Query fragment matching ordinary checkout rows, including legacy rows with no purpose. */
export const ORDER_CHECKOUT_PURPOSE_FILTER = Object.freeze({
  purpose: { $in: [null, EcommercePaymentPurpose.ORDER_CHECKOUT] },
});

export function isBookingPayment(row) {
  return resolvePaymentPurpose(row) !== EcommercePaymentPurpose.ORDER_CHECKOUT || Boolean(row?.bookingId);
}

/** True when the attempt is one of the captures applied to this order. */
export function orderOwnsPaymentAttempt(order, attemptId) {
  if (!attemptId) return false;
  if (order?.successfulPaymentAttemptId === attemptId) return true;
  return (order?.paymentAllocations ?? []).some((entry) => entry.paymentAttemptId === attemptId);
}

/**
 * The captures applied to an order, as `{ paymentAttemptId, purpose, appliedPaise, legacy }`.
 *
 * - Orders with stored `paymentAllocations` use them as written.
 * - Older orders have none: derive a single allocation from `successfulPaymentAttemptId` and the
 *   verified capture amount. `successfulPaymentAttemptId` identifies ONE capture, so it is only
 *   ever used for this fallback and never as the total paid on an order that has allocations.
 *
 * Returns [] when the order has no captured online payment.
 */
export async function resolveOrderPaymentAllocations(order, { session } = {}) {
  const stored = order?.paymentAllocations ?? [];
  if (stored.length) {
    return stored.map((entry) => ({
      paymentAttemptId: entry.paymentAttemptId,
      purpose: entry.purpose,
      appliedPaise: entry.appliedPaise,
      legacy: false,
    }));
  }
  if (!order?.successfulPaymentAttemptId) return [];
  const query = EcommercePaymentAttempt.findOne({
    _id: order.successfulPaymentAttemptId,
    tenantId: order.tenantId,
  }).lean();
  const attempt = await (session ? query.session(session) : query);
  if (!attempt) throw errors.notFound("Payment attempt");
  return [{
    paymentAttemptId: attempt._id,
    purpose: resolvePaymentPurpose(attempt),
    appliedPaise: attempt.amountPaise ?? order.totalPaise,
    legacy: true,
  }];
}

export function totalAppliedPaise(allocations) {
  return allocations.reduce((sum, entry) => sum + entry.appliedPaise, 0);
}
