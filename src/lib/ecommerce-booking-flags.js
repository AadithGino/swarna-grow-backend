import { AppError } from "./app-error.js";

/** Read at call time so a deploy-time env change (and tests) take effect without re-importing. */
export function bookingPaymentsEnabled() {
  return process.env.ECOMMERCE_BOOKING_PAYMENTS_ENABLED === "true";
}

/** Customer booking create, renew and pay stay off until the flag is switched on. */
export function assertBookingPaymentsEnabled() {
  if (!bookingPaymentsEnabled()) {
    throw new AppError("BOOKING_PAYMENTS_DISABLED", "Advance booking is not available yet.", 403);
  }
}
