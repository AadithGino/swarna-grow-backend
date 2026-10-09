import { env } from "../config/env.js";
import { EcommercePaymentAttemptStatus } from "../constants/enums.js";
import { EcommercePaymentAttempt } from "../models/index.js";

const ACTIVE_ATTEMPT_STATUSES = [
  EcommercePaymentAttemptStatus.PENDING,
  EcommercePaymentAttemptStatus.INITIATED,
];

export function paymentReconcileGraceMs() {
  return env.ECOMMERCE_PAYMENT_RECONCILE_GRACE_MS ?? 300_000;
}

export async function findActivePaymentAttempt(tenantId, orderId, session) {
  const q = EcommercePaymentAttempt.findOne({
    tenantId,
    orderId,
    status: { $in: ACTIVE_ATTEMPT_STATUSES },
  });
  return session ? q.session(session).lean() : q.lean();
}

/** True when expiry job must not release stock yet (provider may still succeed). */
export async function orderPaymentExpiryBlockedByInFlight(orderRow, at = new Date(), session) {
  const attempt = await findActivePaymentAttempt(orderRow.tenantId, orderRow._id, session);
  if (!attempt) return false;
  if (attempt.status === EcommercePaymentAttemptStatus.INITIATED) {
    const graceEnd = new Date(
      new Date(orderRow.expiresAt ?? 0).getTime() + paymentReconcileGraceMs(),
    );
    return at <= graceEnd;
  }
  return attempt.status === EcommercePaymentAttemptStatus.PENDING && Boolean(attempt.providerOrderId);
}
