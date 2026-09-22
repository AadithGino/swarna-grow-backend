/**
 * Refundable balance for gateway payments (paise).
 * allocated success amount minus completed refunds minus active reservations.
 */
export function gatewayRefundableBalancePaise(payment) {
  const allocated = payment.allocatedAmountPaise ?? payment.amountPaise ?? 0;
  const refunded = payment.refundedAmountPaise ?? 0;
  const reserved = payment.gatewayRefundReservedPaise ?? 0;
  return allocated - refunded - reserved;
}

export function assertNonNegativeGatewayRefundReserved(payment) {
  const reserved = payment.gatewayRefundReservedPaise ?? 0;
  if (!Number.isSafeInteger(reserved) || reserved < 0) {
    throw new Error("gatewayRefundReservedPaise must be a non-negative safe integer");
  }
}
