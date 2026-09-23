
import { AuditEntityType, AlertType, GatewayRefundStatus, LedgerEntryType, PaymentStatus, SchemeStatus } from "../constants/enums.js";
import { callbackTypeKey } from "../integrations/phonepe.provider.js";
import { gatewayTxFaultCheckpoint } from "../lib/gateway-tx-faults.js";
import { refundWeightDeltaMg } from "../lib/gateway-refund-accounting.js";
import { decrementGatewayRefundReservation } from "../lib/gateway-refund-reservation.js";
import { createId } from "../lib/ids.js";
import { upsertOperationalAlert } from "../lib/operational-alert.js";
import { withTransaction } from "../lib/transaction.js";
import { errors } from "../lib/app-error.js";
import { LedgerEntry, Payment, PaymentIntent, PaymentRefund, Scheme } from "../models/index.js";
import { writeAudit } from "./audit.service.js";
import { nextSchemeLedgerSequence } from "./sequence.service.js";
import { recordPhonePeRefundOutcome } from "../lib/ops-metrics.js";
import { rebuildSchemeProjection } from "./scheme.service.js";

const REFUNDABLE_PAYMENT_STATUSES = new Set([
  PaymentStatus.SUCCESS,
  PaymentStatus.PARTIALLY_REFUNDED,
]);

const TERMINAL_SCHEME_STATUSES = new Set([
  SchemeStatus.MATURED,
  SchemeStatus.REDEEMED,
  SchemeStatus.CLOSED_PREMATURE,
]);

function refundCallbackKind(type) {
  const key = callbackTypeKey(type);
  if (key === "PG_REFUND_COMPLETED") return "COMPLETED";
  if (key === "PG_REFUND_FAILED") return "FAILED";
  if (key === "PG_REFUND_ACCEPTED") return "ACCEPTED";
  return "UNKNOWN";
}

function parseRefundAmountPaise(payload) {
  const amount = Number(payload.amount ?? payload.refundAmount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}

function refundCurrencyValid(payload) {
  const currency = payload.currency ?? payload.currencyCode ?? payload.currency_code;
  if (!currency) return true;
  const normalized = String(currency).toUpperCase();
  return normalized === "INR" || normalized === "IN";
}

async function resolvePaymentForRefund({ tenantId, payload }) {
  const reference =
    payload.originalMerchantOrderId
    ?? payload.merchantOrderId
    ?? payload.orderId
    ?? null;
  if (!reference) return null;
  const intent = await PaymentIntent.findOne({
    tenantId,
    $or: [{ _id: reference }, { providerOrderId: reference }],
  }).lean();
  if (intent?.paymentId) {
    return Payment.findOne({ _id: intent.paymentId, tenantId }).lean();
  }
  return Payment.findOne({
    tenantId,
    $or: [
      { providerTransactionId: reference },
      { receiptNumber: `PENDING-${reference}` },
    ],
  }).lean();
}

async function reversalExistsForRefund({ tenantId, paymentRefundId, session }) {
  return LedgerEntry.exists({
    tenantId,
    type: LedgerEntryType.REVERSAL,
    "metadata.paymentRefundId": paymentRefundId,
  }).session(session);
}

/**
 * Single-flight accounting claim inside the caller's Mongo transaction.
 * Stale claims (claim timestamp set but no REVERSAL) may be reclaimed by matching the prior claim value.
 */
async function claimRefundForAccounting({ tenantId, refundId, session }) {
  if (await reversalExistsForRefund({ tenantId, paymentRefundId: refundId, session })) {
    return { claimed: null, claimOutcome: "DUPLICATE" };
  }

  let claimed = await PaymentRefund.findOneAndUpdate(
    {
      _id: refundId,
      tenantId,
      status: { $ne: GatewayRefundStatus.COMPLETED },
      accountingClaimedAt: { $exists: false },
    },
    { $set: { accountingClaimedAt: new Date() } },
    { session, new: true },
  );
  if (claimed) return { claimed, claimOutcome: "CLAIMED" };

  const snap = await PaymentRefund.findOne({ _id: refundId, tenantId }).session(session).lean();
  if (snap?.status === GatewayRefundStatus.COMPLETED) {
    return { claimed: null, claimOutcome: "DUPLICATE" };
  }
  if (!snap?.accountingClaimedAt) {
    return { claimed: null, claimOutcome: "CONFLICT" };
  }

  claimed = await PaymentRefund.findOneAndUpdate(
    {
      _id: refundId,
      tenantId,
      status: { $ne: GatewayRefundStatus.COMPLETED },
      accountingClaimedAt: snap.accountingClaimedAt,
    },
    { $set: { accountingClaimedAt: new Date() } },
    { session, new: true },
  );
  if (!claimed) {
    return { claimed: null, claimOutcome: "CONFLICT" };
  }
  return { claimed, claimOutcome: "STALE_CLAIM_RECLAIMED" };
}

async function loadOrCreatePaymentRefund({
  tenantId,
  payment,
  idempotencyKey,
  providerRefundId,
  validatedAmount,
  kind,
  payload,
}) {
  let refund = await PaymentRefund.findOne({
    tenantId,
    $or: [
      { providerEventId: idempotencyKey },
      ...(providerRefundId ? [{ providerRefundId }] : []),
    ],
  });
  if (refund) return refund;

  const amountPaiseForCreate =
    validatedAmount
    ?? (kind === "ACCEPTED" ? payment.amountPaise : null);
  if (!amountPaiseForCreate) return null;

  try {
    refund = await PaymentRefund.create({
      _id: createId("pref"),
      tenantId,
      paymentId: payment._id,
      providerRefundId,
      providerEventId: idempotencyKey,
      amountPaise: amountPaiseForCreate,
      status: GatewayRefundStatus.PENDING,
      providerPayload: payload,
    });
    return refund;
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return PaymentRefund.findOne({
      tenantId,
      $or: [
        { providerEventId: idempotencyKey },
        ...(providerRefundId ? [{ providerRefundId }] : []),
      ],
    });
  }
}

async function applyGatewayRefundCompletion({
  tenantId,
  payment,
  refund,
  refundAmountPaise,
  providerRefundId,
  payload,
}) {
  let outcome = "COMPLETED";

  await withTransaction(async (session) => {
    const lockedPayment = await Payment.findOne({
      _id: payment._id,
      tenantId,
      status: { $in: [...REFUNDABLE_PAYMENT_STATUSES] },
    }).session(session);
    if (!lockedPayment) {
      throw errors.business("REFUND_PAYMENT_NOT_REFUNDABLE", "Refund completed but payment is not refundable.");
    }

    const priorRefundedAmount = lockedPayment.refundedAmountPaise ?? 0;
    const priorRefundedWeight = lockedPayment.refundedWeightMg ?? 0;
    const remainingPaise = lockedPayment.amountPaise - priorRefundedAmount;
    if (refundAmountPaise > remainingPaise) {
      await upsertOperationalAlert({
        tenantId,
        type: AlertType.GATEWAY_REFUND_INVALID,
        entityId: payment._id,
        title: "Gateway refund exceeds remaining amount",
        message: "Refund callback amount exceeds the remaining refundable balance.",
        metadata: { providerRefundId, refundAmountPaise, remainingPaise },
        session,
      });
      outcome = "EXCEEDS_REMAINING";
      return;
    }

    const { claimed: claimedRefund, claimOutcome } = await claimRefundForAccounting({
      tenantId,
      refundId: refund._id,
      session,
    });
    if (!claimedRefund) {
      outcome = claimOutcome === "DUPLICATE" ? "DUPLICATE" : "CONFLICT";
      return;
    }
    gatewayTxFaultCheckpoint("refund:claim-set");

    const weightDeltaMg = refundWeightDeltaMg({
      originalPaymentWeightMg: lockedPayment.weightMg ?? 0,
      originalPaymentAmountPaise: lockedPayment.amountPaise,
      priorRefundedAmountPaise: priorRefundedAmount,
      priorRefundedWeightMg: priorRefundedWeight,
      refundAmountPaise,
    });

    const scheme = await Scheme.findOne({
      _id: payment.schemeId,
      tenantId: payment.tenantId,
    }).session(session);
    if (!scheme) throw errors.notFound("Scheme");

    const sequence = await nextSchemeLedgerSequence(
      payment.tenantId,
      payment.schemeId,
      session,
    );
    await LedgerEntry.create(
      [
        {
          _id: createId("ledger"),
          tenantId: payment.tenantId,
          branchId: payment.branchId,
          schemeId: payment.schemeId,
          customerId: payment.customerId,
          paymentId: payment._id,
          type: LedgerEntryType.REVERSAL,
          sequence,
          amountPaise: refundAmountPaise,
          weightMg: weightDeltaMg,
          ratePerGramPaise: payment.ratePerGramPaise,
          cycle: payment.targetCycle,
          actorType: "WEBHOOK",
          actorId: "phonepe-refund",
          reversalOf: payment._id,
          description: `Gateway refund ${providerRefundId ?? ""}`.trim(),
          metadata: { paymentRefundId: claimedRefund._id, providerRefundId },
        },
      ],
      { session },
    );
    gatewayTxFaultCheckpoint("refund:ledger-created");

    const entries = await LedgerEntry.find({
      tenantId: payment.tenantId,
      schemeId: payment.schemeId,
    })
      .sort({ sequence: 1 })
      .session(session)
      .lean();
    rebuildSchemeProjection(scheme, entries);
    scheme.version += 1;
    await scheme.save({ session });
    gatewayTxFaultCheckpoint("refund:scheme-saved");

    const newRefundedAmount = priorRefundedAmount + refundAmountPaise;
    const newRefundedWeight = priorRefundedWeight + weightDeltaMg;
    lockedPayment.refundedAmountPaise = newRefundedAmount;
    lockedPayment.refundedWeightMg = newRefundedWeight;
    lockedPayment.lastRefundedAt = new Date();
    if (newRefundedAmount >= lockedPayment.amountPaise) {
      lockedPayment.status = PaymentStatus.REVERSED;
      lockedPayment.reversedAt = new Date();
      lockedPayment.reversedBy = "phonepe-refund";
      lockedPayment.reversalReason = "GATEWAY_REFUND_COMPLETED";
    } else {
      lockedPayment.status = PaymentStatus.PARTIALLY_REFUNDED;
    }
    await lockedPayment.save({ session });
    await decrementGatewayRefundReservation({
      tenantId,
      paymentId: payment._id,
      releaseAmount: refundAmountPaise,
      session,
      skipWhenNoReservation: true,
    });
    gatewayTxFaultCheckpoint("refund:payment-saved");

    claimedRefund.status = GatewayRefundStatus.COMPLETED;
    claimedRefund.completedAt = new Date();
    claimedRefund.amountPaise = refundAmountPaise;
    claimedRefund.providerPayload = payload;
    claimedRefund.requiresReview = false;
    claimedRefund.reviewReason = undefined;
    await claimedRefund.save({ session });
    gatewayTxFaultCheckpoint("refund:refund-completed");

    if (TERMINAL_SCHEME_STATUSES.has(scheme.status)) {
      await upsertOperationalAlert({
        tenantId,
        type: AlertType.GATEWAY_REFUND_PARTIAL,
        entityId: payment._id,
        title: "Gateway refund on terminal scheme",
        message: "A gateway refund was applied while the scheme is matured, redeemed, or closed — review may be required.",
        metadata: { providerRefundId, schemeStatus: scheme.status, refundAmountPaise },
        session,
      });
    }

    await writeAudit({
      req: {
        auth: { id: "phonepe-refund", tenantId, type: "WEBHOOK" },
        headers: {},
        ip: "provider",
      },
      action: newRefundedAmount >= lockedPayment.amountPaise ? "PAYMENT_REVERSED" : "PAYMENT_PARTIALLY_REFUNDED",
      entityType: AuditEntityType.PAYMENT,
      entityId: payment._id,
      after: lockedPayment.toObject(),
      metadata: { refundId: claimedRefund._id, providerRefundId, refundAmountPaise, weightDeltaMg },
      actorType: "WEBHOOK",
      session,
    });
    gatewayTxFaultCheckpoint("refund:audit-written");
  });

  return { outcome };
}

export async function processPhonePeRefundWebhook({
  tenantId,
  type,
  payload = {},
  providerEventId,
}) {
  const kind = refundCallbackKind(type);
  if (kind === "UNKNOWN") return { outcome: "IGNORED" };

  const providerRefundId =
    payload.refundId
    ?? payload.merchantRefundId
    ?? providerEventId;
  if (!providerRefundId) {
    await upsertOperationalAlert({
      tenantId,
      type: AlertType.GATEWAY_REFUND_INVALID,
      entityId: providerEventId ?? createId("pref"),
      title: "Invalid gateway refund callback",
      message: "Refund webhook missing refund identifier.",
      metadata: { type: callbackTypeKey(type) },
    });
    return { outcome: "INVALID_REFUND_ID" };
  }

  const payment = await resolvePaymentForRefund({ tenantId, payload });
  if (!payment) {
    await upsertOperationalAlert({
      tenantId,
      type: AlertType.GATEWAY_REFUND_UNMATCHED,
      entityId: providerRefundId,
      title: "Unmatched gateway refund",
      message: "Refund callback did not match a tenant payment.",
      metadata: { providerRefundId, type: callbackTypeKey(type) },
    });
    recordPhonePeRefundOutcome("UNMATCHED");
    return { outcome: "UNMATCHED" };
  }

  const idempotencyKey = providerEventId ?? `${providerRefundId}:${kind}`;
  const validatedAmount = parseRefundAmountPaise(payload);

  if (kind === "COMPLETED") {
    if (!validatedAmount) {
      await upsertOperationalAlert({
        tenantId,
        type: AlertType.GATEWAY_REFUND_INVALID,
        entityId: payment._id,
        title: "Invalid gateway refund amount",
        message: "Refund completed callback missing a finite positive amount.",
        metadata: { providerRefundId, paymentId: payment._id },
      });
      return { outcome: "INVALID_AMOUNT" };
    }
    if (!refundCurrencyValid(payload)) {
      await upsertOperationalAlert({
        tenantId,
        type: AlertType.GATEWAY_REFUND_CURRENCY_MISMATCH,
        entityId: payment._id,
        title: "Gateway refund currency mismatch",
        message: "Refund callback currency is not supported for automatic reversal.",
        metadata: { providerRefundId, paymentId: payment._id, currency: payload.currency },
      });
      return { outcome: "CURRENCY_MISMATCH" };
    }
  }

  const refund = await loadOrCreatePaymentRefund({
    tenantId,
    payment,
    idempotencyKey,
    providerRefundId,
    validatedAmount,
    kind,
    payload,
  });
  if (!refund) {
    return { outcome: "INVALID_AMOUNT" };
  }

  if (kind === "ACCEPTED") {
    if (refund.status === GatewayRefundStatus.COMPLETED) {
      return { outcome: "ALREADY_COMPLETED", refundId: refund._id };
    }
    await PaymentRefund.updateOne(
      { _id: refund._id, tenantId, status: { $ne: GatewayRefundStatus.COMPLETED } },
      {
        $set: {
          status: GatewayRefundStatus.ACCEPTED,
          providerPayload: payload,
        },
      },
    );
    recordPhonePeRefundOutcome("ACCEPTED");
    return { outcome: "ACCEPTED", refundId: refund._id };
  }

  if (kind === "FAILED") {
    if (refund.status === GatewayRefundStatus.COMPLETED) {
      return { outcome: "ALREADY_COMPLETED", refundId: refund._id };
    }
    await withTransaction(async (session) => {
      const failedRefund = await PaymentRefund.findOneAndUpdate(
        {
          _id: refund._id,
          tenantId,
          status: {
            $in: [
              GatewayRefundStatus.PENDING,
              GatewayRefundStatus.PENDING_RECONCILIATION,
              GatewayRefundStatus.ACCEPTED,
            ],
          },
        },
        {
          $set: {
            status: GatewayRefundStatus.FAILED,
            failedAt: new Date(),
            providerPayload: payload,
          },
        },
        { session, new: true },
      );
      if (!failedRefund) return;
      const failedAmount = failedRefund.amountPaise ?? validatedAmount ?? 0;
      if (failedAmount > 0) {
        await decrementGatewayRefundReservation({
          tenantId,
          paymentId: payment._id,
          releaseAmount: failedAmount,
          session,
          skipWhenNoReservation: true,
        });
      }
    });
    recordPhonePeRefundOutcome("FAILED");
    return { outcome: "FAILED", refundId: refund._id };
  }

  if (kind === "COMPLETED") {
    const refundAmountPaise = validatedAmount;
    if (refund.status === GatewayRefundStatus.COMPLETED) {
      recordPhonePeRefundOutcome("DUPLICATE");
      return { outcome: "DUPLICATE", refundId: refund._id };
    }

    if (!REFUNDABLE_PAYMENT_STATUSES.has(payment.status)) {
      await upsertOperationalAlert({
        tenantId,
        type: AlertType.GATEWAY_REFUND_NON_SUCCESS_PAYMENT,
        entityId: payment._id,
        title: "Refund on non-success payment",
        message: "A completed refund callback arrived for a payment that is not successful.",
        metadata: { providerRefundId, paymentStatus: payment.status },
      });
      await PaymentRefund.updateOne(
        { _id: refund._id, tenantId },
        {
          $set: {
            status: GatewayRefundStatus.COMPLETED,
            completedAt: new Date(),
            amountPaise: refundAmountPaise,
            providerPayload: payload,
            requiresReview: true,
            reviewReason: "REFUND_ON_NON_SUCCESS_PAYMENT",
          },
        },
      );
      recordPhonePeRefundOutcome("NON_SUCCESS_PAYMENT");
      return { outcome: "NON_SUCCESS_PAYMENT", refundId: refund._id };
    }

    try {
      const applied = await applyGatewayRefundCompletion({
        tenantId,
        payment,
        refund,
        refundAmountPaise,
        providerRefundId,
        payload,
      });
      if (applied.outcome === "DUPLICATE") {
        recordPhonePeRefundOutcome("DUPLICATE");
        return { outcome: "DUPLICATE", refundId: refund._id };
      }
      if (applied.outcome === "CONFLICT") {
        await upsertOperationalAlert({
          tenantId,
          type: AlertType.GATEWAY_REFUND_DUPLICATE_CONFLICT,
          entityId: payment._id,
          title: "Gateway refund conflict",
          message: "Refund completion could not apply atomically due to payment state conflict.",
          metadata: { providerRefundId },
        });
        recordPhonePeRefundOutcome("CONFLICT");
        return { outcome: "CONFLICT", refundId: refund._id };
      }
      if (applied.outcome === "EXCEEDS_REMAINING") {
        recordPhonePeRefundOutcome("EXCEEDS_REMAINING");
        return { outcome: "EXCEEDS_REMAINING", refundId: refund._id };
      }
      if (applied.outcome !== "COMPLETED") {
        return { outcome: applied.outcome, refundId: refund._id };
      }
    } catch (error) {
      if (error.code === "REFUND_PAYMENT_NOT_REFUNDABLE" || error.message?.includes("REFUND_PAYMENT_NOT_REFUNDABLE")) {
        await upsertOperationalAlert({
          tenantId,
          type: AlertType.GATEWAY_REFUND_DUPLICATE_CONFLICT,
          entityId: payment._id,
          title: "Gateway refund conflict",
          message: "Refund completion could not apply atomically due to payment state conflict.",
          metadata: { providerRefundId },
        });
        recordPhonePeRefundOutcome("CONFLICT");
        return { outcome: "CONFLICT", refundId: refund._id };
      }
      throw error;
    }

    recordPhonePeRefundOutcome("COMPLETED");
    return { outcome: "COMPLETED", refundId: refund._id };
  }

  return { outcome: "IGNORED" };
}
