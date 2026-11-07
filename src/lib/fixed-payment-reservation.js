import {
  PaymentIntentStatus,
  PaymentMode,
  PaymentPattern,
  PaymentStatus,
} from "../constants/enums.js";
import {
  PhonePeOrderStatusKind,
  normalizePhonePeOrderStatus,
} from "./phonepe-order-status.js";
import {
  phonePeProvider,
  resolvePhonePeCredentials,
} from "../integrations/phonepe.provider.js";
import { AppError } from "./app-error.js";
import { errors } from "./app-error.js";
import {
  buildFixedPayableQuote,
  isFixedPaymentAmountAllowed,
  previewFixedAllocation,
} from "./fixed-payment-policy.js";
import { Payment, PaymentIntent, PaymentLink, Scheme, Tenant } from "../models/index.js";
import { createId } from "./ids.js";
import { resolveGatewayMerchantOrderIdFromRows } from "./phonepe-gateway-merchant-order-id.js";

export const FIXED_RESERVATION_TTL_MS = 30 * 60_000;
/** While a customer is still on PhonePe, keep the instalment hold briefly. */
/** Hosted PhonePe checkout window (~5 min on merchant page); do not fail PENDING before this. */
export const FIXED_GATEWAY_CHECKOUT_GRACE_MS = 5 * 60_000;

function merchantOrderIdForGatewayPayment(payment, intent, link = null) {
  return resolveGatewayMerchantOrderIdFromRows(payment, { intent, link }) ?? null;
}

/** True when the intent holds a Phase 4 fixed installment reservation (not legacy gateway checkout). */
export function isFixedReservationIntent(intent) {
  const from = intent?.fixedFromInstallment;
  return Number.isInteger(from) && from >= 1;
}

export function fixedReservationExpiryDate(from = new Date()) {
  return new Date(from.getTime() + FIXED_RESERVATION_TTL_MS);
}

/** One active online checkout per fixed scheme — supersede stale holds when the customer retries. */
export async function expireCompetingFixedReservations(tenantId, schemeId, session = null) {
  const pending = await PaymentIntent.find({
    tenantId,
    schemeId,
    status: PaymentIntentStatus.PENDING,
    fixedFromInstallment: { $gte: 1 },
  })
    .select("_id paymentId")
    .session(session ?? null)
    .lean();
  if (!pending.length) return 0;
  let released = 0;
  for (const intent of pending) {
    const updated = await PaymentIntent.updateOne(
      { _id: intent._id, tenantId, status: PaymentIntentStatus.PENDING },
      { $set: { status: PaymentIntentStatus.EXPIRED }, $inc: { version: 1 } },
    ).session(session ?? null);
    if (updated.modifiedCount) released += 1;
    if (!intent.paymentId) continue;
    await Payment.updateOne(
      { _id: intent.paymentId, tenantId, status: PaymentStatus.PENDING },
      {
        $set: {
          status: PaymentStatus.FAILED,
          providerPayload: { cancellationReason: "SUPERSEDED_BY_NEW_CHECKOUT" },
        },
      },
      { session: session ?? null },
    );
  }
  return released;
}

/** Release fixed holds that never received a gateway payment row (broken / abandoned initiate). */
export async function detachOrphanFixedReservations(tenantId, schemeId, session = null) {
  const intents = await PaymentIntent.find({
    tenantId,
    schemeId,
    status: PaymentIntentStatus.PENDING,
    fixedFromInstallment: { $gte: 1 },
    $or: [{ paymentId: null }, { paymentId: { $exists: false } }],
  })
    .select("_id")
    .session(session ?? null)
    .lean();
  if (!intents.length) return 0;
  let released = 0;
  for (const intent of intents) {
    const updated = await PaymentIntent.updateOne(
      { _id: intent._id, tenantId, status: PaymentIntentStatus.PENDING },
      { $set: { status: PaymentIntentStatus.EXPIRED }, $inc: { version: 1 } },
    ).session(session ?? null);
    if (updated.modifiedCount) released += 1;
  }
  return released;
}

/** Fail long-stuck PENDING gateway rows so instalment capacity returns after a bad checkout. */
export async function detachAbandonedFixedGatewayAttempts(
  tenantId,
  schemeId,
  { maxPendingAgeMs = 2 * 60_000 } = {},
) {
  const intents = await listActiveFixedReservations(tenantId, schemeId);
  if (!intents.length) return 0;
  const { applyTerminalGatewayFailure } =
    await import("../services/gateway-terminal-failure.service.js");
  const cutoff = Date.now() - maxPendingAgeMs;
  let released = 0;
  for (const intent of intents) {
    if (!intent.paymentId) continue;
    const payment = await Payment.findOne({ _id: intent.paymentId, tenantId }).lean();
    if (!payment || payment.status !== PaymentStatus.PENDING) continue;
    const started = new Date(payment.paidAt ?? payment.createdAt ?? Date.now()).getTime();
    if (started > cutoff) continue;
    const reference =
      payment.receiptNumber?.startsWith("PENDING-")
        ? payment.receiptNumber.slice("PENDING-".length)
        : intent._id;
    const result = await applyTerminalGatewayFailure({
      tenantId,
      paymentId: payment._id,
      reference,
      providerPayload: { reason: "ABANDONED_CHECKOUT" },
    });
    if (!result.skipped) released += 1;
  }
  return released;
}

/** Drop fixed installment holds tied to failed gateway attempts (failed payments should not block new tries). */
export async function detachFailedFixedReservations(tenantId, schemeId, session = null) {
  const intents = await PaymentIntent.find({
    tenantId,
    schemeId,
    status: PaymentIntentStatus.PENDING,
    fixedFromInstallment: { $gte: 1 },
    paymentId: { $ne: null },
  })
    .select("_id paymentId")
    .session(session ?? null)
    .lean();
  if (!intents.length) return 0;
  const paymentIds = [...new Set(intents.map((row) => row.paymentId).filter(Boolean))];
  const failedPayments = await Payment.find({
    tenantId,
    _id: { $in: paymentIds },
    status: { $in: [PaymentStatus.FAILED, PaymentStatus.REVERSED] },
  })
    .select("_id")
    .session(session ?? null)
    .lean();
  if (!failedPayments.length) return 0;
  const failedSet = new Set(failedPayments.map((row) => String(row._id)));
  let released = 0;
  for (const intent of intents) {
    if (!failedSet.has(String(intent.paymentId))) continue;
    const updated = await PaymentIntent.updateOne(
      { _id: intent._id, tenantId, status: PaymentIntentStatus.PENDING },
      { $set: { status: PaymentIntentStatus.FAILED }, $inc: { version: 1 } },
    ).session(session ?? null);
    if (updated.modifiedCount) released += 1;
  }
  return released;
}

/**
 * After reconcile, drop PENDING gateway holds that did not succeed (failed checkout must not
 * reduce payable). Keeps a short grace window for an in-flight PhonePe session.
 */
export async function detachStalePendingFixedHoldsAfterReconcile(
  tenantId,
  schemeId,
  { graceMs = FIXED_GATEWAY_CHECKOUT_GRACE_MS } = {},
) {
  const intents = await listActiveFixedReservations(tenantId, schemeId);
  if (!intents.length) return 0;
  const { applyTerminalGatewayFailure } =
    await import("../services/gateway-terminal-failure.service.js");
  const tenant = await Tenant.findById(tenantId).select("+integrationSecrets").lean();
  const credentials = resolvePhonePeCredentials(tenant);
  const now = Date.now();
  let released = 0;

  for (const intent of intents) {
    if (!intent.paymentId) continue;
    const payment = await Payment.findOne({ _id: intent.paymentId, tenantId }).lean();
    if (
      !payment
      || payment.status !== PaymentStatus.PENDING
      || payment.mode !== PaymentMode.ONLINE_GATEWAY
    ) {
      continue;
    }
    const started = new Date(payment.paidAt ?? payment.createdAt ?? Date.now()).getTime();
    const ageMs = now - started;
    const link = await PaymentLink.findOne({ tenantId, paymentId: payment._id }).select("_id paymentId").lean();
    const merchantOrderId = merchantOrderIdForGatewayPayment(payment, intent, link);

    let shouldFail = false;
    let reason = "CHECKOUT_NOT_COMPLETED";

    if (credentials?.clientId && merchantOrderId) {
      try {
        const status = await phonePeProvider.getOrderStatus(
          merchantOrderId,
          credentials,
          tenantId,
        );
        const normalized = normalizePhonePeOrderStatus(status);
        if (normalized.kind === PhonePeOrderStatusKind.COMPLETED) {
          continue;
        }
        if (normalized.kind === PhonePeOrderStatusKind.TERMINAL_FAILED) {
          shouldFail = true;
          reason = "GATEWAY_TERMINAL_FAILED";
        } else if (ageMs >= graceMs) {
          shouldFail = true;
        }
      } catch {
        if (ageMs >= graceMs) {
          shouldFail = true;
          reason = "GATEWAY_STATUS_UNAVAILABLE";
        }
      }
    } else if (ageMs >= graceMs) {
      shouldFail = true;
    }

    if (!shouldFail) continue;

    const result = await applyTerminalGatewayFailure({
      tenantId,
      paymentId: payment._id,
      reference: merchantOrderId,
      providerPayload: { reason, quoteRefresh: true },
    });
    if (!result.skipped) released += 1;
  }
  return released;
}

/** Reconcile stuck gateway attempts, then detach failed holds before quoting payable range. */
export async function refreshFixedInstallmentReservationCapacity(tenantId, schemeId) {
  await detachOrphanFixedReservations(tenantId, schemeId);
  await detachFailedFixedReservations(tenantId, schemeId);
  const intents = await listActiveFixedReservations(tenantId, schemeId);
  if (intents.length) {
    const { reconcileGatewayPayment } = await import("../services/phonepe-reconcile.service.js");
    for (const intent of intents.slice(0, 8)) {
      if (!intent.paymentId) continue;
      const payment = await Payment.findOne({ _id: intent.paymentId, tenantId }).lean();
      if (
        !payment
        || payment.status !== PaymentStatus.PENDING
        || payment.mode !== PaymentMode.ONLINE_GATEWAY
      ) {
        continue;
      }
      try {
        await reconcileGatewayPayment(payment, {
          source: "FIXED_RESERVATION_REFRESH",
          leaseWorkerLabel: "payable-range",
        });
      } catch {
        /* best-effort — expiry job will retry */
      }
    }
  }
  await detachFailedFixedReservations(tenantId, schemeId);
  await detachStalePendingFixedHoldsAfterReconcile(tenantId, schemeId);
  await detachFailedFixedReservations(tenantId, schemeId);
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
    {
      $lookup: {
        from: Payment.collection.name,
        localField: "paymentId",
        foreignField: "_id",
        as: "paymentDoc",
      },
    },
    {
      $match: {
        paymentId: { $ne: null },
        "paymentDoc.0.status": PaymentStatus.PENDING,
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
  await expireCompetingFixedReservations(tenantId, schemeObj._id, session);
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
