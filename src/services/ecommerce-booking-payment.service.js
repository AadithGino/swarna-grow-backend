import { createId } from "../lib/ids.js";
import { withTransaction } from "../lib/transaction.js";
import { upsertOperationalAlert } from "../lib/operational-alert.js";
import { bookingBranchOf } from "../lib/ecommerce-booking-scope.js";
import { reserveCaptureRefund } from "../lib/ecommerce-refund-allocator.js";
import { recomputeBookingRefundStatusFor } from "../lib/ecommerce-booking-refund-status.js";
import { getBookingPaymentHandlers } from "../lib/ecommerce-booking-payment-handlers.js";
import { paymentReconcileGraceMs } from "../lib/ecommerce-payment-in-flight.js";
import { IDENTITY_CHANGED, attemptIdentity, identityFilter, sameIdentity } from "../lib/ecommerce-payment-identity.js";
import { isRecognizedPendingState } from "../lib/phonepe-order-status.js";
import { resolvePaymentPurpose } from "../lib/ecommerce-payment-allocations.js";
import {
  AlertType,
  EcommerceOrderRefundSource,
  EcommercePaymentAttemptOperationalStatus,
  EcommercePaymentAttemptStatus,
} from "../constants/enums.js";
import { EcommercePaymentAttempt, EcommercePaymentAttemptEvent } from "../models/index.js";

/**
 * Finalization of payments that belong to a booking rather than an order. The order finalizer
 * hands booking captures here; there is no order to load, lock or move, so the only state this
 * layer owns is the payment attempt, its events, and the refund of money the booking cannot keep.
 */

const ACTIVE = [EcommercePaymentAttemptStatus.PENDING, EcommercePaymentAttemptStatus.INITIATED];

/** Refund operation for a capture the booking could not accept. One per attempt, so replays reuse it. */
export const lateCaptureOperationId = (attemptId) => `late-capture:${attemptId}`;

async function recordEvent({ attempt, webhookEventId, direction = "INBOUND", outcome, reason, payload, session }) {
  await EcommercePaymentAttemptEvent.create([{
    _id: createId("epayev"),
    tenantId: attempt.tenantId,
    bookingId: attempt.bookingId,
    purpose: resolvePaymentPurpose(attempt),
    ...(attempt.orderId ? { orderId: attempt.orderId } : {}),
    paymentAttemptId: attempt._id,
    webhookEventId: webhookEventId ?? null,
    direction,
    outcome,
    reason: reason ?? "",
    payload: payload ?? {},
  }], { session });
}

const result = (outcome, attempt, extra = {}) => ({
  outcome,
  bookingId: attempt.bookingId,
  purpose: resolvePaymentPurpose(attempt),
  paymentAttemptId: attempt._id,
  ...extra,
});

/**
 * A verified capture arrived (webhook or reconcile). Marks the attempt SUCCEEDED, lets the booking
 * accept it, and if the booking cannot (closed, expired, already settled) refunds the whole capture.
 * Idempotent: a replay of an already-succeeded attempt changes nothing.
 */
export async function finalizeBookingPaymentSuccess({
  attempt,
  transactionId,
  amountPaise,
  currency = "INR",
  providerPayload,
  webhookEventId,
  source = "WEBHOOK",
  expectedIdentity,
}) {
  if (attempt.status === EcommercePaymentAttemptStatus.SUCCEEDED) return result("ALREADY_SUCCESS", attempt);
  if (expectedIdentity && !sameIdentity(expectedIdentity, attempt)) return result(IDENTITY_CHANGED, attempt);

  if (String(attempt.currency ?? "INR") !== String(currency ?? "INR")) {
    await recordEvent({ attempt, webhookEventId, outcome: "CURRENCY_MISMATCH",
      reason: `Expected ${attempt.currency ?? "INR"}, got ${currency}`, payload: providerPayload });
    return result("CURRENCY_MISMATCH", attempt);
  }
  if (Number(attempt.amountPaise) !== Number(amountPaise)) {
    await recordEvent({ attempt, webhookEventId, outcome: "AMOUNT_MISMATCH",
      reason: `Expected ${attempt.amountPaise}, got ${amountPaise}`, payload: providerPayload });
    return result("AMOUNT_MISMATCH", attempt);
  }

  return withTransaction(async (session) => {
    // Any status but SUCCEEDED may become SUCCEEDED: the provider's verified capture is the truth,
    // including for an attempt that was already expired or failed locally.
    const updated = await EcommercePaymentAttempt.findOneAndUpdate(
      {
        _id: attempt._id,
        tenantId: attempt.tenantId,
        status: { $ne: EcommercePaymentAttemptStatus.SUCCEEDED },
        ...identityFilter(expectedIdentity),
      },
      {
        $set: {
          status: EcommercePaymentAttemptStatus.SUCCEEDED,
          providerPaymentId: transactionId ?? attempt.providerPaymentId,
          providerPayload,
        },
        $unset: { failureReason: "" },
        $inc: { version: 1 },
      },
      { session, new: true },
    ).lean();
    if (!updated) {
      const current = await EcommercePaymentAttempt.findById(attempt._id).session(session).lean();
      if (expectedIdentity && current && !sameIdentity(expectedIdentity, current)) return result(IDENTITY_CHANGED, current);
      return result("ALREADY_SUCCESS", attempt);
    }

    const decision = await getBookingPaymentHandlers().onCaptured({ attempt: updated, source, session });
    if (decision?.accepted) {
      await recordEvent({ attempt: updated, webhookEventId, outcome: "SUCCESS", reason: source,
        payload: providerPayload, session });
      return result("SUCCESS", updated);
    }

    const reason = decision?.reason ?? "BOOKING_REJECTED_CAPTURE";
    await reserveCaptureRefund({
      tenantId: updated.tenantId,
      paymentAttemptId: updated._id,
      amountPaise: updated.amountPaise,
      operationId: lateCaptureOperationId(updated._id),
      refundSource: EcommerceOrderRefundSource.PAYMENT_EXCEPTION,
      session,
    });
    // The refund row exists now, so the booking summary must say a refund is owed.
    await recomputeBookingRefundStatusFor({ tenantId: updated.tenantId, bookingId: updated.bookingId, session });
    await recordEvent({ attempt: updated, webhookEventId, outcome: "LATE_CAPTURE_REFUND_ASSIGNED", reason,
      payload: providerPayload, session });
    await upsertOperationalAlert({
      tenantId: updated.tenantId,
      type: AlertType.GATEWAY_WEBHOOK_UNMATCHED,
      entityId: updated.bookingId,
      branchId: await bookingBranchOf({ tenantId: updated.tenantId, bookingId: updated.bookingId, session }),
      title: "Booking payment captured but not accepted",
      message: "A booking payment was captured after the booking could accept it. A full refund was assigned.",
      metadata: { bookingId: updated.bookingId, paymentAttemptId: updated._id, reason },
      session,
    });
    return result("LATE_CAPTURE_REFUND_ASSIGNED", updated, { reason });
  });
}

/** The provider reported a terminal failure. Only an active attempt can fail. */
export async function finalizeBookingPaymentTerminalFailure({
  attempt,
  transactionId,
  providerPayload,
  webhookEventId,
  reason,
  expectedIdentity,
}) {
  if (attempt.status === EcommercePaymentAttemptStatus.SUCCEEDED) return result("ALREADY_SUCCESS", attempt);
  if (expectedIdentity && !sameIdentity(expectedIdentity, attempt)) return result(IDENTITY_CHANGED, attempt);
  return withTransaction(async (session) => {
    const updated = await EcommercePaymentAttempt.findOneAndUpdate(
      { _id: attempt._id, tenantId: attempt.tenantId, status: { $in: ACTIVE }, ...identityFilter(expectedIdentity) },
      {
        $set: {
          status: EcommercePaymentAttemptStatus.FAILED,
          failureReason: reason ?? "PROVIDER_TERMINAL_FAILURE",
          providerPaymentId: transactionId ?? attempt.providerPaymentId,
          providerPayload,
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    ).lean();
    if (!updated) {
      const current = await EcommercePaymentAttempt.findById(attempt._id).session(session).lean();
      if (expectedIdentity && current && !sameIdentity(expectedIdentity, current)) return result(IDENTITY_CHANGED, current);
      return result("NOOP", attempt);
    }
    await getBookingPaymentHandlers().onFailed({ attempt: updated, reason: "FAILED", session });
    await recordEvent({ attempt: updated, webhookEventId, outcome: "FAILED", reason, payload: providerPayload, session });
    return result("FAILED", updated);
  });
}

/** An initiation claim that has not lapsed: a provider call may be running right now. */
function initiationClaimActive(attempt, at) {
  return Boolean(attempt.initiationClaimToken)
    && Boolean(attempt.initiationClaimExpiresAt)
    && new Date(attempt.initiationClaimExpiresAt) > at;
}

/** True when the provider may still capture this attempt, so it must not be expired yet. */
function expiryBlockedByInFlight(attempt, at) {
  if (initiationClaimActive(attempt, at)) return true;
  if (attempt.status === EcommercePaymentAttemptStatus.INITIATED) {
    const graceEnd = new Date(new Date(attempt.expiresAt ?? 0).getTime() + paymentReconcileGraceMs());
    return at <= graceEnd;
  }
  return attempt.status === EcommercePaymentAttemptStatus.PENDING && Boolean(attempt.providerOrderId);
}

/**
 * An attempt may have reached the provider if it has a provider order, initiation completed or was
 * started (a claim token that is still set after the claim lapsed means the initiating call died
 * without recording its outcome), or initiation was ever marked uncertain. That marker
 * (initiationUncertainAt) is evidence kept apart from operationalStatus, which reconciliation
 * progress and operator acknowledgements overwrite.
 */
function mayHaveReachedProvider(attempt) {
  if (String(attempt.provider ?? "").toUpperCase() === "MOCK") return false;
  return Boolean(attempt.providerOrderId)
    || Boolean(attempt.initiationClaimToken)
    || Boolean(attempt.initiationUncertainAt)
    || attempt.status === EcommercePaymentAttemptStatus.INITIATED
    || attempt.operationalStatus === EcommercePaymentAttemptOperationalStatus.INITIATION_UNCERTAIN;
}

/** Bounded so a record that keeps changing under us is reported, not chased forever. */
const MAX_EXPIRY_PASSES = 3;

/**
 * Expires an unpaid booking attempt. Guards, in order:
 *  1. The attempt's own persisted deadline (`expiresAt`) must have passed. An attempt with no
 *     deadline is never expired here.
 *  2. If the provider may have seen the attempt it is asked first, so a payment the customer
 *     actually made is confirmed instead of expired. Only a definite, recognized "still pending"
 *     answer allows expiry. A failed poll, a missing tenant, an empty or unrecognized response
 *     leaves the attempt active for the caller to retry.
 *  3. The in-flight window must be over, and no initiation claim may be live. An attempt whose
 *     initiation was started but never recorded (lapsed claim, or INITIATION_UNCERTAIN) counts as
 *     possibly seen by the provider and is polled under guard 2. A poll answer is only used for
 *     the provider order it was asked about.
 * The final state change is conditional on everything those guards looked at (status, provider
 * order id, merchant order id, initiation claim, operational state, deadline). If another writer moved the attempt in between, for example payment
 * initiation, nothing is expired: the attempt is reloaded and every guard is evaluated again, up
 * to MAX_EXPIRY_PASSES times, after which CHANGED_CONCURRENTLY is returned and the attempt stays
 * active. An attempt that does expire can still be captured later; that capture is refunded in
 * full by finalizeBookingPaymentSuccess.
 */
export async function expireBookingPaymentAttempt({ tenantId, attemptId, at = new Date(), reason = "BOOKING_PAYMENT_EXPIRED" }) {
  let latest = null;
  for (let pass = 0; pass < MAX_EXPIRY_PASSES; pass += 1) {
    let attempt = await EcommercePaymentAttempt.findOne({ _id: attemptId, tenantId }).lean();
    if (!attempt || !attempt.bookingId) return { outcome: "NOT_FOUND" };
    latest = attempt;
    if (!ACTIVE.includes(attempt.status)) return result("NOT_ACTIVE", attempt, { status: attempt.status });
    if (!attempt.expiresAt) return result("NO_DEADLINE", attempt);
    if (new Date(attempt.expiresAt) > at) return result("NOT_DUE", attempt, { expiresAt: attempt.expiresAt });

    // A live initiation claim means a provider call is running; nothing to ask yet.
    if (initiationClaimActive(attempt, at)) return result("IN_FLIGHT", attempt);

    if (mayHaveReachedProvider(attempt)) {
      const { reconcileEcommercePaymentAttempt } = await import("./ecommerce-payment-reconcile.service.js");
      const polledIdentity = attemptIdentity(attempt);
      const polled = await reconcileEcommercePaymentAttempt(attempt, { at });
      attempt = await EcommercePaymentAttempt.findOne({ _id: attemptId, tenantId }).lean();
      latest = attempt;
      if (!ACTIVE.includes(attempt.status)) return result("NOT_ACTIVE", attempt, { status: attempt.status });
      // The answer describes the order that was asked about. If the attempt now points at another
      // provider order, the answer says nothing about it: discard it and evaluate from scratch.
      if (!sameIdentity(polledIdentity, attempt)) continue;
      // PhonePe saying it has no such order is as definite as "still pending", but only for an attempt
      // that never got a provider order id, whose initiation claim has lapsed, and only once the
      // in-flight grace after the deadline is over: a slow initiation call could still create it.
      // A later capture of that order is refunded in full like any late capture.
      const definitelyNoOrder = polled?.outcome === "POLL_FAILED" && polled.orderNotFound === true
        && !attempt.providerOrderId && !initiationClaimActive(attempt, at)
        && at > new Date(new Date(attempt.expiresAt).getTime() + paymentReconcileGraceMs());
      const definitelyPending = definitelyNoOrder
        || (polled?.outcome === "STILL_PENDING" && isRecognizedPendingState(polled.providerState));
      if (!definitelyPending) {
        return result("PROVIDER_UNRESOLVED", attempt, {
          providerOutcome: polled?.outcome ?? "UNKNOWN",
          providerState: polled?.providerState ?? null,
        });
      }
    }
    if (expiryBlockedByInFlight(attempt, at)) return result("IN_FLIGHT", attempt);

    const expired = await withTransaction(async (session) => {
      const updated = await EcommercePaymentAttempt.findOneAndUpdate(
        {
          _id: attempt._id,
          tenantId,
          // Exactly the state the guards above were evaluated against. `null` also matches a
          // missing field, so "no provider order yet" is part of the condition.
          status: attempt.status,
          provider: attempt.provider ?? null,
          merchantOrderId: attempt.merchantOrderId ?? null,
          providerOrderId: attempt.providerOrderId ?? null,
          initiationClaimToken: attempt.initiationClaimToken ?? null,
          initiationUncertainAt: attempt.initiationUncertainAt ?? null,
          operationalStatus: attempt.operationalStatus ?? null,
          expiresAt: { $lte: at },
        },
        { $set: { status: EcommercePaymentAttemptStatus.EXPIRED, failureReason: String(reason).slice(0, 120) }, $inc: { version: 1 } },
        { session, new: true },
      ).lean();
      if (!updated) return null;
      await getBookingPaymentHandlers().onFailed({ attempt: updated, reason: "EXPIRED", session });
      await recordEvent({ attempt: updated, direction: "INTERNAL", outcome: "EXPIRED", reason, session });
      return result("EXPIRED", updated);
    });
    if (expired) return expired;
  }
  return result("CHANGED_CONCURRENTLY", latest);
}
