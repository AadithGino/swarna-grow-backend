import { PaymentIntentStatus, PaymentPattern } from "../constants/enums.js";
import { AppError } from "./app-error.js";
import { errors } from "./app-error.js";
import {
  buildFixedPayableQuote,
  isFixedPaymentAmountAllowed,
  previewFixedAllocation,
} from "./fixed-payment-policy.js";
import { PaymentIntent, Scheme } from "../models/index.js";
import { createId } from "./ids.js";

export const FIXED_RESERVATION_TTL_MS = 30 * 60_000;

/** True when the intent holds a Phase 4 fixed installment reservation (not legacy gateway checkout). */
export function isFixedReservationIntent(intent) {
  const from = intent?.fixedFromInstallment;
  return Number.isInteger(from) && from >= 1;
}

export function fixedReservationExpiryDate(from = new Date()) {
  return new Date(from.getTime() + FIXED_RESERVATION_TTL_MS);
}

/** Sum of active fixed-scheme payment intent reservations. */
export async function sumActiveFixedReservationPaise(tenantId, schemeId, session = null) {
  const now = new Date();
  const q = PaymentIntent.aggregate([
    {
      $match: {
        tenantId,
        schemeId,
        status: PaymentIntentStatus.PENDING,
        reservationExpiresAt: { $gt: now },
        fixedFromInstallment: { $gte: 1 },
      },
    },
    { $group: { _id: null, amountPaise: { $sum: "$amountPaise" }, intentIds: { $push: "$_id" } } },
  ]);
  if (session) q.session(session);
  const rows = await q;
  return {
    reservedPaise: rows[0]?.amountPaise ?? 0,
    intentIds: rows[0]?.intentIds ?? [],
  };
}

export async function listActiveFixedReservations(tenantId, schemeId, session = null) {
  const now = new Date();
  const q = PaymentIntent.find({
    tenantId,
    schemeId,
    status: PaymentIntentStatus.PENDING,
    reservationExpiresAt: { $gt: now },
    fixedFromInstallment: { $gte: 1 },
  }).lean();
  if (session) q.session(session);
  return q;
}

export function assertNoBlockingFixedReservations(blocking, message) {
  if (!blocking.intentIds.length) return;
  throw errors.business(
    "PAYMENT_CONFIRMATION_PENDING",
    message ?? "A pending online payment is reserving part of this scheme's payable capacity.",
    {
      blockingIntentIds: blocking.intentIds,
      reservedPaise: blocking.reservedPaise,
    },
  );
}

/** Create a fixed PaymentIntent reservation and bump scheme.version atomically. */
export async function reserveFixedPaymentIntentInSession(
  session,
  {
    tenantId,
    scheme,
    amountPaise,
    expiresAt,
    excludeIntentId = null,
  },
) {
  if (scheme.paymentPattern !== PaymentPattern.FIXED) {
    throw errors.business(
      "PAYMENT_INTENT_NOT_APPLICABLE",
      "Fixed installment reservations apply only to fixed schemes.",
    );
  }
  const schemeObj = typeof scheme.toObject === "function" ? scheme.toObject() : scheme;
  const paymentRules = schemeObj.planSnapshot?.paymentRules ?? {};
  const blocking = await sumActiveFixedReservationPaise(tenantId, schemeObj._id, session);
  if (excludeIntentId) {
    const excluded = await PaymentIntent.findOne({ _id: excludeIntentId }).session(session).lean();
    if (excluded?.status === PaymentIntentStatus.PENDING) {
      blocking.reservedPaise = Math.max(0, blocking.reservedPaise - excluded.amountPaise);
      blocking.intentIds = blocking.intentIds.filter((id) => id !== excludeIntentId);
    }
  }
  const quote = buildFixedPayableQuote(schemeObj, paymentRules, {
    reservedPaise: blocking.reservedPaise,
  });
  if (!isFixedPaymentAmountAllowed(quote, amountPaise)) {
    if (blocking.reservedPaise > 0) {
      throw errors.business(
        "PAYMENT_CONFIRMATION_PENDING",
        "This amount exceeds remaining payable capacity after active online reservations.",
        { blockingIntentIds: blocking.intentIds, reservedPaise: blocking.reservedPaise, quote },
      );
    }
    throw errors.business(
      "INVALID_PAYMENT_AMOUNT",
      "This payment amount is not allowed for the current installment schedule.",
      { allowedAmountsPaise: quote.allowedAmountsPaise, quote },
    );
  }
  const allocation = previewFixedAllocation(
    schemeObj.installments ?? [],
    amountPaise,
    paymentRules,
  );
  const expectedVersion = schemeObj.version;
  const bumped = await Scheme.findOneAndUpdate(
    { _id: schemeObj._id, tenantId, version: expectedVersion },
    { $inc: { version: 1 } },
    { session, new: true },
  );
  if (!bumped) {
    throw new AppError(
      "VERSION_CONFLICT",
      "The payable position changed. Refresh and try again.",
      409,
    );
  }
  const intent = (
    await PaymentIntent.create(
      [
        {
          _id: createId("paymentIntent"),
          tenantId,
          branchId: schemeObj.branchId,
          schemeId: schemeObj._id,
          customerId: schemeObj.customerId,
          amountPaise,
          positionVersion: bumped.version,
          reservationExpiresAt: expiresAt,
          fixedFromInstallment: allocation.fromInstallment,
          fixedThroughInstallment: allocation.throughInstallment,
        },
      ],
      { session },
    )
  )[0];
  return { intent, quote, positionVersion: bumped.version };
}

export function fixedReservationConsumable(intent, scheme, paymentRules, now = new Date()) {
  if (!isFixedReservationIntent(intent)) return { ok: false, reason: "NOT_FIXED_RESERVATION" };
  if (intent.status !== PaymentIntentStatus.PENDING) return { ok: false, reason: "INTENT_NOT_PENDING" };
  if (intent.reservationExpiresAt && intent.reservationExpiresAt <= now) {
    return { ok: false, reason: "RESERVATION_EXPIRED" };
  }
  const quote = buildFixedPayableQuote(scheme, paymentRules, { reservedPaise: 0 });
  if (!isFixedPaymentAmountAllowed(quote, intent.amountPaise)) {
    return { ok: false, reason: "ALLOCATION_NO_LONGER_VALID" };
  }
  const allocation = previewFixedAllocation(
    scheme.installments ?? [],
    intent.amountPaise,
    paymentRules,
  );
  if (
    allocation.fromInstallment !== intent.fixedFromInstallment
    || allocation.throughInstallment !== intent.fixedThroughInstallment
  ) {
    return { ok: false, reason: "INSTALLMENT_POSITION_CHANGED" };
  }
  return { ok: true, allocation, quote };
}

export async function recordStaleFixedReservationGatewaySuccess({
  session,
  tenantId,
  scheme,
  payment,
  reason,
}) {
  const { OutboxEvent } = await import("../models/index.js");
  const { upsertOperationalAlert } = await import("./operational-alert.js");
  const { AlertType } = await import("../constants/enums.js");
  await upsertOperationalAlert({
    tenantId,
    type: AlertType.PAYMENT_REVIEW,
    entityId: payment._id,
    title: "Unallocated fixed-scheme gateway payment",
    message:
      "A gateway payment succeeded but its installment reservation was no longer valid. Funds require manual review.",
    entityType: "PAYMENT",
    metadata: {
      branchId: payment.branchId ?? scheme.branchId,
      schemeId: scheme._id,
      customerId: scheme.customerId,
      paymentId: payment._id,
      reason: reason ?? "STALE_FIXED_RESERVATION",
    },
    session,
  });
  try {
    await OutboxEvent.create(
      [
        {
          tenantId,
          topic: "payment.unallocated.fixed_reservation_stale",
          key: payment._id,
          payload: {
            paymentId: payment._id,
            schemeId: scheme._id,
            customerId: scheme.customerId,
            branchId: payment.branchId ?? scheme.branchId,
            reason: reason ?? "STALE_FIXED_RESERVATION",
          },
        },
      ],
      { session },
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
}
