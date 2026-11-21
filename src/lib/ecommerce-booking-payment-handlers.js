/**
 * The seam between gateway payment handling and the booking lifecycle.
 *
 * The payment layer (webhook, reconcile, expiry) knows how to confirm, fail, expire and refund a
 * booking-owned capture, but it does not decide what a captured advance means for a booking: that
 * belongs to the booking service. The booking service registers these handlers; until it does,
 * the defaults are deliberately conservative: a capture nobody accepts is refunded in full, so
 * money is never kept for a booking the system cannot account for.
 *
 * Handlers run inside the payment transaction. If one throws, the whole transaction rolls back and
 * the gateway delivery is retried, so they must be idempotent.
 *
 *  onCaptured({ attempt, source, session }) -> { accepted: boolean, reason?: string }
 *      Apply a verified capture to the booking. Return accepted:false when the booking cannot take
 *      it (unknown, cancelled, expired, already settled): the full capture is then refunded.
 *  onFailed({ attempt, reason, session })
 *      The attempt failed or expired without a capture.
 *  onRefundSettled({ refund, session })
 *      A booking-owned refund reached SUCCEEDED or MANUAL_RECORDED.
 *  onRefundFailed({ refund, session })
 *      A booking-owned refund failed at the provider.
 */
const DEFAULT_HANDLERS = Object.freeze({
  async onCaptured() {
    return { accepted: false, reason: "BOOKING_HANDLER_NOT_REGISTERED" };
  },
  async onFailed() {},
  async onRefundSettled() {},
  async onRefundFailed() {},
});

let handlers = DEFAULT_HANDLERS;

export function registerBookingPaymentHandlers(next) {
  handlers = Object.freeze({ ...DEFAULT_HANDLERS, ...next });
}

export function resetBookingPaymentHandlers() {
  handlers = DEFAULT_HANDLERS;
}

export function getBookingPaymentHandlers() {
  return handlers;
}
