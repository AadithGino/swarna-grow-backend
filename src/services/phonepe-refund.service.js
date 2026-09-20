import { AuditEntityType } from "../constants/enums.js";
import { GatewayRefundStatus, LedgerEntryType, PaymentStatus } from "../constants/enums.js";
import { callbackTypeKey } from "../integrations/phonepe.provider.js";
import { gatewayTxFaultCheckpoint } from "../lib/gateway-tx-faults.js";
import { createId } from "../lib/ids.js";
import { withTransaction } from "../lib/transaction.js";
import { errors } from "../lib/app-error.js";
import { Alert, LedgerEntry, Payment, PaymentIntent, PaymentRefund, Scheme } from "../models/index.js";
import { writeAudit } from "./audit.service.js";
import { nextSchemeLedgerSequence } from "./sequence.service.js";
import { recordPhonePeRefundOutcome } from "../lib/ops-metrics.js";
import { rebuildSchemeProjection } from "./scheme.service.js";

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

async function upsertRefundAlert({
  tenantId,
  type,
  entityId,
  title,
  message,
  metadata,
  session = null,
}) {
  await Alert.findOneAndUpdate(
    { tenantId, type, entityId, status: "OPEN" },
    {
      $setOnInsert: {
        severity: "CRITICAL",
        title,
        message,
        entityType: "PAYMENT",
        metadata,
      },
    },
    { upsert: true, ...(session ? { session } : {}) },
  );
}

async function applyPartialRefundReviewAtomic({
  tenantId,
  payment,
  refund,
  refundAmountPaise,
  providerRefundId,
  payload,
}) {
  await withTransaction(async (session) => {
    await Payment.updateOne(
      { _id: payment._id, tenantId },
      {
        $set: {
          requiresReview: true,
          reviewReason: "PARTIAL_REFUND_REQUIRES_REVIEW",
        },
      },
      { session },
    );
    gatewayTxFaultCheckpoint("partialRefund:payment-updated");

    await PaymentRefund.updateOne(
      { _id: refund._id, tenantId },
      {
        $set: {
          status: GatewayRefundStatus.COMPLETED,
          completedAt: new Date(),
          amountPaise: refundAmountPaise,
          providerPayload: payload,
          requiresReview: true,
          reviewReason: "PARTIAL_REFUND",
        },
      },
      { session },
    );
    gatewayTxFaultCheckpoint("partialRefund:refund-updated");

    await upsertRefundAlert({
      tenantId,
      type: "GATEWAY_REFUND_PARTIAL",
      entityId: payment._id,
      title: "Partial gateway refund requires review",
      message: "Refund amount differs from the original payment amount.",
      metadata: {
        providerRefundId,
        expectedPaise: payment.amountPaise,
        receivedPaise: refundAmountPaise,
      },
      session,
    });
    gatewayTxFaultCheckpoint("partialRefund:alert-upserted");

    await writeAudit({
      req: {
        auth: { id: "phonepe-refund", tenantId, type: "WEBHOOK" },
        headers: {},
        ip: "provider",
      },
      action: "GATEWAY_REFUND_PARTIAL_REVIEW",
      entityType: AuditEntityType.PAYMENT,
      entityId: payment._id,
      after: { paymentId: payment._id, refundId: refund._id },
      metadata: { providerRefundId, refundAmountPaise },
      actorType: "WEBHOOK",
      session,
    });
    gatewayTxFaultCheckpoint("partialRefund:audit-written");
  });
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
    await upsertRefundAlert({
      tenantId,
      type: "GATEWAY_REFUND_INVALID",
      entityId: providerEventId ?? createId("pref"),
      title: "Invalid gateway refund callback",
      message: "Refund webhook missing refund identifier.",
      metadata: { type },
    });
    return { outcome: "INVALID_REFUND_ID" };
  }

  const payment = await resolvePaymentForRefund({ tenantId, payload });
  if (!payment) {
    await upsertRefundAlert({
      tenantId,
      type: "GATEWAY_REFUND_UNMATCHED",
      entityId: providerRefundId,
      title: "Unmatched gateway refund",
      message: "Refund callback did not match a tenant payment.",
      metadata: { providerRefundId, type },
    });
    recordPhonePeRefundOutcome("UNMATCHED");
    return { outcome: "UNMATCHED" };
  }

  const idempotencyKey = providerEventId ?? `${providerRefundId}:${kind}`;
  const validatedAmount = parseRefundAmountPaise(payload);

  if (kind === "COMPLETED") {
    if (!validatedAmount) {
      await upsertRefundAlert({
        tenantId,
        type: "GATEWAY_REFUND_INVALID",
        entityId: payment._id,
        title: "Invalid gateway refund amount",
        message: "Refund completed callback missing a finite positive amount.",
        metadata: { providerRefundId, paymentId: payment._id },
      });
      return { outcome: "INVALID_AMOUNT" };
    }
    if (!refundCurrencyValid(payload)) {
      await upsertRefundAlert({
        tenantId,
        type: "GATEWAY_REFUND_CURRENCY_MISMATCH",
        entityId: payment._id,
        title: "Gateway refund currency mismatch",
        message: "Refund callback currency is not supported for automatic reversal.",
        metadata: { providerRefundId, paymentId: payment._id, currency: payload.currency },
      });
      return { outcome: "CURRENCY_MISMATCH" };
    }
  }

  let refund = await PaymentRefund.findOne({
    tenantId,
    $or: [
      { providerEventId: idempotencyKey },
      ...(providerRefundId ? [{ providerRefundId }] : []),
    ],
  });

  if (!refund) {
    const amountPaiseForCreate =
      validatedAmount
      ?? (kind === "ACCEPTED" ? payment.amountPaise : null);
    if (!amountPaiseForCreate) {
      return { outcome: "INVALID_AMOUNT" };
    }
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
    await PaymentRefund.updateOne(
      { _id: refund._id, tenantId },
      {
        $set: {
          status: GatewayRefundStatus.FAILED,
          failedAt: new Date(),
          providerPayload: payload,
        },
      },
    );
    recordPhonePeRefundOutcome("FAILED");
    return { outcome: "FAILED", refundId: refund._id };
  }

  if (kind === "COMPLETED") {
    const refundAmountPaise = validatedAmount;
    if (refund.status === GatewayRefundStatus.COMPLETED) {
      if (refund.requiresReview && refund.reviewReason === "PARTIAL_REFUND") {
        await applyPartialRefundReviewAtomic({
          tenantId,
          payment,
          refund,
          refundAmountPaise,
          providerRefundId,
          payload,
        });
        return { outcome: "PARTIAL_REVIEW_REPAIRED", refundId: refund._id };
      }
      return { outcome: "DUPLICATE", refundId: refund._id };
    }

    if (refundAmountPaise !== payment.amountPaise) {
      await applyPartialRefundReviewAtomic({
        tenantId,
        payment,
        refund,
        refundAmountPaise,
        providerRefundId,
        payload,
      });
      recordPhonePeRefundOutcome("PARTIAL_REVIEW");
      return { outcome: "PARTIAL_REVIEW", refundId: refund._id };
    }

    if (payment.status !== PaymentStatus.SUCCESS) {
      await upsertRefundAlert({
        tenantId,
        type: "GATEWAY_REFUND_NON_SUCCESS_PAYMENT",
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
      await withTransaction(async (session) => {
        const lockedRefund = await PaymentRefund.findOne({
          _id: refund._id,
          tenantId,
          status: { $ne: GatewayRefundStatus.COMPLETED },
        }).session(session);
        if (!lockedRefund) return;

        const lockedPayment = await Payment.findOne({
          _id: payment._id,
          tenantId,
          status: PaymentStatus.SUCCESS,
        }).session(session);
        if (!lockedPayment) {
          throw errors.business("REFUND_PAYMENT_NOT_SUCCESS", "Refund completed but payment is not successful.");
        }

        const existingReversal = await LedgerEntry.exists({
          tenantId,
          paymentId: payment._id,
          type: LedgerEntryType.REVERSAL,
        }).session(session);
        if (!existingReversal) {
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
                amountPaise: payment.amountPaise,
                weightMg: payment.weightMg,
                ratePerGramPaise: payment.ratePerGramPaise,
                cycle: payment.targetCycle,
                actorType: "WEBHOOK",
                actorId: "phonepe-refund",
                reversalOf: payment._id,
                description: `Gateway refund ${providerRefundId ?? ""}`.trim(),
              },
            ],
            { session },
          );
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
          gatewayTxFaultCheckpoint("fullRefund:scheme-saved");
          gatewayTxFaultCheckpoint("fullRefund:ledger-created");
        }

        lockedPayment.status = PaymentStatus.REVERSED;
        lockedPayment.reversedAt = new Date();
        lockedPayment.reversedBy = "phonepe-refund";
        lockedPayment.reversalReason = "GATEWAY_REFUND_COMPLETED";
        await lockedPayment.save({ session });
        gatewayTxFaultCheckpoint("fullRefund:payment-reversed");

        lockedRefund.status = GatewayRefundStatus.COMPLETED;
        lockedRefund.completedAt = new Date();
        lockedRefund.amountPaise = refundAmountPaise;
        lockedRefund.providerPayload = payload;
        await lockedRefund.save({ session });
        gatewayTxFaultCheckpoint("fullRefund:refund-completed");

        await writeAudit({
          req: {
            auth: { id: "phonepe-refund", tenantId, type: "WEBHOOK" },
            headers: {},
            ip: "provider",
          },
          action: "PAYMENT_REVERSED",
          entityType: AuditEntityType.PAYMENT,
          entityId: payment._id,
          after: lockedPayment.toObject(),
          metadata: { refundId: lockedRefund._id, providerRefundId },
          actorType: "WEBHOOK",
          session,
        });
        gatewayTxFaultCheckpoint("fullRefund:audit-written");
      });
    } catch (error) {
      if (error.code === "REFUND_PAYMENT_NOT_SUCCESS" || error.message?.includes("REFUND_PAYMENT_NOT_SUCCESS")) {
        await upsertRefundAlert({
          tenantId,
          type: "GATEWAY_REFUND_DUPLICATE_CONFLICT",
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
