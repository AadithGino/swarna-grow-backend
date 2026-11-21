import { EcommercePaymentAttempt, EcommercePaymentExceptionRefund } from "../models/index.js";
import {
  EcommerceOrderRefundSource,
  EcommercePaymentAttemptStatus,
  EcommercePaymentExceptionRefundStatus,
  EcommercePaymentPurpose,
} from "../constants/enums.js";
import { errors } from "./app-error.js";
import { createId } from "./ids.js";
import { resolveOrderPaymentAllocations, resolvePaymentPurpose } from "./ecommerce-payment-allocations.js";

/**
 * Statuses that hold refundable capacity on a capture. A pending or unknown provider outcome keeps
 * holding it; only a confirmed terminal FAILED frees it (the provider paths set FAILED only on a
 * verified failure and leave timeouts as PROVIDER_PENDING).
 */
export const CAPACITY_CONSUMING_REFUND_STATUSES = Object.freeze([
  EcommercePaymentExceptionRefundStatus.ASSIGNED,
  EcommercePaymentExceptionRefundStatus.INITIATED,
  EcommercePaymentExceptionRefundStatus.PROVIDER_PENDING,
  EcommercePaymentExceptionRefundStatus.SUCCEEDED,
  EcommercePaymentExceptionRefundStatus.MANUAL_RECORDED,
]);

/** Refund sources that draw down the share of a capture applied to the order invoice. */
const ORDER_LEVEL_REFUND_SOURCES = new Set([
  EcommerceOrderRefundSource.ORDER_CANCELLATION,
  EcommerceOrderRefundSource.ORDER_RETURN,
]);

/** Balance first, then ordinary checkout, then advance last. */
const PURPOSE_REFUND_RANK = {
  [EcommercePaymentPurpose.BOOKING_BALANCE]: 0,
  [EcommercePaymentPurpose.ORDER_CHECKOUT]: 1,
  [EcommercePaymentPurpose.BOOKING_ADVANCE]: 2,
};

export function compareCapturesForRefund(a, b) {
  const rank = (PURPOSE_REFUND_RANK[a.purpose] ?? 1) - (PURPOSE_REFUND_RANK[b.purpose] ?? 1);
  if (rank !== 0) return rank;
  return String(a.paymentAttemptId).localeCompare(String(b.paymentAttemptId));
}

/**
 * Pure planner. `captures` are `{ paymentAttemptId, purpose, availablePaise }`.
 * Returns the per-capture amounts (balance first) and any amount that no capture can cover.
 */
export function planRefundAllocations({ captures, amountPaise }) {
  let remaining = amountPaise;
  const allocations = [];
  for (const capture of [...captures].sort(compareCapturesForRefund)) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Math.max(0, capture.availablePaise));
    if (take <= 0) continue;
    allocations.push({ paymentAttemptId: capture.paymentAttemptId, purpose: capture.purpose, amountPaise: take });
    remaining -= take;
  }
  return { allocations, shortfallPaise: remaining };
}

function sumBy(rows, predicate) {
  return rows.filter(predicate).reduce((sum, row) => sum + row.amountPaise, 0);
}

/**
 * Locks each capture for the rest of the transaction. Concurrent refund operations that touch the
 * same capture write the same document, so one of them gets a write conflict and the transaction
 * helper retries it against the committed state. Returns the attempts, keyed by id.
 */
async function lockCaptures({ tenantId, attemptIds, session }) {
  const attempts = new Map();
  for (const id of [...attemptIds].sort()) {
    const attempt = await EcommercePaymentAttempt.findOneAndUpdate(
      { _id: id, tenantId },
      { $inc: { refundCapacityLockSeq: 1 } },
      { session, new: true },
    ).lean();
    if (!attempt) throw errors.notFound("Payment attempt");
    attempts.set(id, attempt);
  }
  return attempts;
}

/**
 * Refundable capacity exists only for money that was actually captured. An attempt that is still
 * PENDING/INITIATED, or that failed or expired without a capture, has nothing to refund.
 */
function assertCaptured(attempt) {
  if (attempt.status !== EcommercePaymentAttemptStatus.SUCCEEDED) {
    throw errors.business("REFUND_PAYMENT_NOT_CAPTURED",
      "The original payment was not captured, so there is nothing to refund.",
      { paymentAttemptId: attempt._id, attemptStatus: attempt.status });
  }
}

async function consumingRows({ tenantId, attemptIds, session }) {
  return EcommercePaymentExceptionRefund.find({
    tenantId,
    paymentAttemptId: { $in: attemptIds },
    status: { $in: [...CAPACITY_CONSUMING_REFUND_STATUSES] },
  }).session(session).lean();
}

/**
 * Reserves refund capacity against an order's captures and creates one refund row per capture.
 * Must run inside a transaction. Replaying the same `operationId` returns the rows it already
 * created; it never allocates twice.
 *
 * `legacyLookup` is an extra filter that finds rows of the same operation written before
 * refundOperationId existed (it is only needed until the backfill has run everywhere).
 */
export async function reserveOrderRefunds({
  tenantId,
  order,
  amountPaise,
  operationId,
  refundSource,
  extra = {},
  legacyLookup = null,
  notApplicableMessage = "No successful online payment on this order.",
  session,
}) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw errors.validation([{ field: "amountPaise", message: "Refund amount must be a positive whole number of paise." }]);
  }
  const existingFilter = legacyLookup
    ? { tenantId, $or: [{ refundOperationId: operationId }, { tenantId, ...legacyLookup }] }
    : { tenantId, refundOperationId: operationId };
  const existing = await EcommercePaymentExceptionRefund.find(existingFilter).session(session).sort({ _id: 1 }).lean();
  if (existing.length) {
    const total = existing.reduce((sum, row) => sum + row.amountPaise, 0);
    if (total !== amountPaise) {
      throw errors.conflict("REFUND_OPERATION_AMOUNT_CHANGED",
        "A refund for this operation already exists with a different amount.");
    }
    return { rows: existing, created: false };
  }

  const allocations = await resolveOrderPaymentAllocations(order, { session });
  if (!allocations.length) throw errors.business("REFUND_NOT_APPLICABLE", notApplicableMessage);

  const attempts = await lockCaptures({ tenantId, attemptIds: allocations.map((entry) => entry.paymentAttemptId), session });
  for (const attempt of attempts.values()) assertCaptured(attempt);
  const consumed = await consumingRows({ tenantId, attemptIds: [...attempts.keys()], session });
  const captures = allocations.map((entry) => {
    const attempt = attempts.get(entry.paymentAttemptId);
    const forAttempt = (row) => row.paymentAttemptId === entry.paymentAttemptId;
    const captureLeft = (attempt.amountPaise ?? entry.appliedPaise) - sumBy(consumed, forAttempt);
    const shareLeft = entry.appliedPaise
      - sumBy(consumed, (row) => forAttempt(row) && ORDER_LEVEL_REFUND_SOURCES.has(row.refundSource));
    return {
      paymentAttemptId: entry.paymentAttemptId,
      purpose: entry.purpose ?? resolvePaymentPurpose(attempt),
      availablePaise: Math.min(captureLeft, shareLeft),
    };
  });
  const plan = planRefundAllocations({ captures, amountPaise });
  if (plan.shortfallPaise > 0) {
    throw errors.business("REFUND_EXCEEDS_CAPTURED",
      "The refund is more than what is left to refund on the original payments.",
      { shortfallPaise: plan.shortfallPaise });
  }

  const docs = plan.allocations.map((entry) => {
    const attempt = attempts.get(entry.paymentAttemptId);
    return {
      _id: createId("epayref"),
      tenantId,
      orderId: order._id,
      ...(attempt.bookingId ? { bookingId: attempt.bookingId } : {}),
      purpose: entry.purpose,
      refundOperationId: operationId,
      paymentAttemptId: entry.paymentAttemptId,
      amountPaise: entry.amountPaise,
      currency: attempt.currency ?? "INR",
      providerPaymentId: attempt.providerPaymentId,
      merchantOrderId: attempt.merchantOrderId ?? attempt._id,
      status: EcommercePaymentExceptionRefundStatus.ASSIGNED,
      refundSource,
      ...extra,
    };
  });
  const rows = await EcommercePaymentExceptionRefund.insertMany(docs, { session });
  return { rows: rows.map((row) => row.toObject()), created: true };
}

/**
 * Refunds an amount against ONE specific capture, for money that is not part of an order invoice:
 * the excess of an advance over the final bill, or a booking that expires or is cancelled before an
 * order exists. Same rules as reserveOrderRefunds: runs in a transaction, keyed by a stable
 * `operationId`, replays return the existing row, and the capture's total across every operation
 * can never exceed what was captured.
 */
export async function reserveCaptureRefund({
  tenantId,
  paymentAttemptId,
  amountPaise,
  operationId,
  refundSource,
  orderId = null,
  extra = {},
  session,
}) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw errors.validation([{ field: "amountPaise", message: "Refund amount must be a positive whole number of paise." }]);
  }
  const existing = await EcommercePaymentExceptionRefund.find({
    tenantId, refundOperationId: operationId, paymentAttemptId,
  }).session(session).lean();
  if (existing.length) {
    if (existing[0].amountPaise !== amountPaise) {
      throw errors.conflict("REFUND_OPERATION_AMOUNT_CHANGED",
        "A refund for this operation already exists with a different amount.");
    }
    return { rows: existing, created: false };
  }
  const attempts = await lockCaptures({ tenantId, attemptIds: [paymentAttemptId], session });
  const attempt = attempts.get(paymentAttemptId);
  assertCaptured(attempt);
  const consumed = await consumingRows({ tenantId, attemptIds: [paymentAttemptId], session });
  const left = attempt.amountPaise - sumBy(consumed, () => true);
  if (left < amountPaise) {
    throw errors.business("REFUND_EXCEEDS_CAPTURED",
      "The refund is more than what is left to refund on the original payment.",
      { shortfallPaise: amountPaise - left });
  }
  const [row] = await EcommercePaymentExceptionRefund.insertMany([{
    _id: createId("epayref"),
    tenantId,
    ...(orderId ? { orderId } : {}),
    ...(attempt.bookingId ? { bookingId: attempt.bookingId } : {}),
    purpose: resolvePaymentPurpose(attempt),
    refundOperationId: operationId,
    paymentAttemptId,
    amountPaise,
    currency: attempt.currency ?? "INR",
    providerPaymentId: attempt.providerPaymentId,
    merchantOrderId: attempt.merchantOrderId ?? attempt._id,
    status: EcommercePaymentExceptionRefundStatus.ASSIGNED,
    refundSource,
    ...extra,
  }], { session });
  return { rows: [row.toObject()], created: true };
}

/**
 * Called inside the transaction that moves a FAILED refund row back to an active status. The row
 * is reused (same id, same operation); this re-reserves its capacity against the capture and
 * refuses the retry if the freed capacity has since been taken by another refund.
 */
export async function reserveCapacityForRefundRetry({ tenantId, refundRow, session }) {
  const attempts = await lockCaptures({ tenantId, attemptIds: [refundRow.paymentAttemptId], session });
  const attempt = attempts.get(refundRow.paymentAttemptId);
  // Late and duplicate captures are refunded while their attempt is not SUCCEEDED; the refund row
  // was created from a confirmed provider capture, so it must carry the provider payment id.
  if (attempt.status !== EcommercePaymentAttemptStatus.SUCCEEDED && !refundRow.providerPaymentId) {
    assertCaptured(attempt);
  }
  const consumed = await consumingRows({ tenantId, attemptIds: [refundRow.paymentAttemptId], session });
  const left = (attempt.amountPaise ?? refundRow.amountPaise)
    - sumBy(consumed, (row) => row._id !== refundRow._id);
  if (left < refundRow.amountPaise) {
    throw errors.conflict("REFUND_CAPACITY_CONSUMED",
      "Another refund now holds this payment's refundable amount; this refund cannot be retried.");
  }
}
