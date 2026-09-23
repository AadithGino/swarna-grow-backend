import {
  AuditEntityType,
  AlertType,
  GatewayRefundStatus,
  PaymentMode,
  PaymentStatus,
} from "../constants/enums.js";
import { phonePeProvider, resolvePhonePeCredentials } from "../integrations/phonepe.provider.js";
import { classifyRefundInitiationError } from "../lib/gateway-refund-initiation-classifier.js";
import {
  markRefundPendingReconciliation,
  refundInitiationMayRetry,
  releaseGatewayRefundReservation,
} from "../lib/gateway-refund-reservation.js";
import { refundInitiationTestCheckpoint } from "../lib/gateway-refund-initiation-test-hooks.js";
import { createId } from "../lib/ids.js";
import { upsertOperationalAlert } from "../lib/operational-alert.js";
import { withTransaction } from "../lib/transaction.js";
import { errors } from "../lib/app-error.js";
import { Payment, PaymentIntent, PaymentRefund, Tenant } from "../models/index.js";
import { writeAudit } from "./audit.service.js";
import { reconcileGatewayRefundRecord } from "./phonepe-refund-reconcile.service.js";

const REFUNDABLE = new Set([PaymentStatus.SUCCESS, PaymentStatus.PARTIALLY_REFUNDED]);

function idempotencyPayloadMatches(refund, { amountPaise, reason }) {
  return refund.amountPaise === amountPaise && String(refund.reason ?? "").trim() === String(reason).trim();
}

export async function initiateAdminPaymentRefund(req) {
  const { amountPaise, reason } = req.body ?? {};
  const trimmedReason = String(reason ?? "").trim();
  if (!trimmedReason) {
    throw errors.business("REFUND_REASON_REQUIRED", "Refund reason is required.");
  }
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw errors.business("REFUND_AMOUNT_INVALID", "amountPaise must be a positive safe integer.");
  }

  const idempotencyKey = req.headers["x-idempotency-key"];
  if (!idempotencyKey) {
    throw errors.business("IDEMPOTENCY_KEY_REQUIRED", "x-idempotency-key header is required.");
  }

  let refund;
  let reused = false;

  try {
    await withTransaction(async (session) => {
      const existing = await PaymentRefund.findOne({
        tenantId: req.auth.tenantId,
        paymentId: req.params.paymentId,
        idempotencyKey,
      }).session(session);
      if (existing) {
        if (!idempotencyPayloadMatches(existing, { amountPaise, reason: trimmedReason })) {
          throw errors.conflict(
            "IDEMPOTENCY_CONFLICT",
            "The same idempotency key was already used with a different refund request.",
          );
        }
        refund = existing;
        reused = true;
        return;
      }

      const payment = await Payment.findOne({
        _id: req.params.paymentId,
        tenantId: req.auth.tenantId,
        ...(req.scope.branchId ? { branchId: req.scope.branchId } : {}),
      }).session(session);
      if (!payment) throw errors.notFound("Payment");
      if (payment.mode !== PaymentMode.ONLINE_GATEWAY) {
        throw errors.business("REFUND_NOT_GATEWAY", "Only PhonePe gateway payments support provider refunds.");
      }
      if (!REFUNDABLE.has(payment.status)) {
        throw errors.business("REFUND_PAYMENT_NOT_REFUNDABLE", "Payment is not in a refundable state.");
      }
      if (payment.requiresReview) {
        throw errors.business("REFUND_REQUIRES_REVIEW", "Resolve payment review before initiating a provider refund.");
      }

      const reservedPayment = await Payment.findOneAndUpdate(
        {
          _id: payment._id,
          tenantId: payment.tenantId,
          mode: PaymentMode.ONLINE_GATEWAY,
          status: { $in: [...REFUNDABLE] },
          $expr: {
            $gte: [
              {
                $subtract: [
                  "$amountPaise",
                  {
                    $add: [
                      { $ifNull: ["$refundedAmountPaise", 0] },
                      { $ifNull: ["$gatewayRefundReservedPaise", 0] },
                    ],
                  },
                ],
              },
              amountPaise,
            ],
          },
        },
        { $inc: { gatewayRefundReservedPaise: amountPaise } },
        { session, new: true },
      );
      if (!reservedPayment) {
        throw errors.business("REFUND_AMOUNT_EXCEEDS_REMAINING", "Refund amount exceeds remaining refundable balance.");
      }

      const intent = await PaymentIntent.findOne({
        tenantId: payment.tenantId,
        paymentId: payment._id,
      }).session(session).lean();
      if (!intent?._id) {
        throw errors.business("REFUND_NO_ORDER_REFERENCE", "Payment is missing a PhonePe merchant order reference.");
      }

      const merchantRefundId = createId("pref");
      const created = await PaymentRefund.create(
        [
          {
            _id: merchantRefundId,
            tenantId: payment.tenantId,
            paymentId: payment._id,
            providerRefundId: merchantRefundId,
            amountPaise,
            status: GatewayRefundStatus.PENDING,
            idempotencyKey,
            reason: trimmedReason,
            initiatedBy: req.auth.id,
            providerInitiationAttempts: 0,
          },
        ],
        { session },
      );
      refund = created[0];

      await writeAudit({
        req,
        action: "GATEWAY_REFUND_INITIATED",
        entityType: AuditEntityType.PAYMENT,
        entityId: payment._id,
        after: { refundId: refund._id, amountPaise, reason: trimmedReason },
        metadata: { idempotencyKey },
        session,
      });
    });
  } catch (error) {
    if (error?.code === 11000) {
      const existing = await PaymentRefund.findOne({
        tenantId: req.auth.tenantId,
        paymentId: req.params.paymentId,
        idempotencyKey,
      }).lean();
      if (existing && idempotencyPayloadMatches(existing, { amountPaise, reason: trimmedReason })) {
        refund = existing;
        reused = true;
      } else {
        throw errors.conflict(
          "IDEMPOTENCY_CONFLICT",
          "The same idempotency key was already used with a different refund request.",
        );
      }
    } else {
      throw error;
    }
  }

  refundInitiationTestCheckpoint("post-commit");

  refund = await PaymentRefund.findById(refund._id).lean();
  if (reused && !refundInitiationMayRetry(refund)) {
    return { refundId: refund._id, status: refund.status, reused: true };
  }

  const payment = await Payment.findById(refund.paymentId).lean();
  const intent = await PaymentIntent.findOne({
    tenantId: payment.tenantId,
    paymentId: payment._id,
  }).lean();
  const originalMerchantOrderId = intent?._id;

  const tenant = await Tenant.findById(payment.tenantId).select("+integrationSecrets").lean();
  const credentials = resolvePhonePeCredentials(tenant);
  if (!credentials) {
    await releaseGatewayRefundReservation({
      tenantId: payment.tenantId,
      paymentId: payment._id,
      refundId: refund._id,
      amountPaise: refund.amountPaise,
      reviewReason: "PAYMENT_GATEWAY_NOT_CONFIGURED",
    });
    throw errors.business("PAYMENT_GATEWAY_NOT_CONFIGURED", "PhonePe is not configured.");
  }

  try {
    await phonePeProvider.initiateRefund({
      merchantRefundId: refund._id,
      originalMerchantOrderId,
      amountPaise: refund.amountPaise,
      credentials,
      tenantId: payment.tenantId,
    });
    await PaymentRefund.updateOne(
      { _id: refund._id },
      {
        $inc: { providerInitiationAttempts: 1 },
        $set: {
          lastInitiationAt: new Date(),
          providerInitiationError: null,
          status: GatewayRefundStatus.PENDING,
          requiresReview: false,
          reviewReason: undefined,
        },
      },
    );
  } catch (error) {
    const attempts = (refund.providerInitiationAttempts ?? 0) + 1;
    const failureClass = classifyRefundInitiationError(error);
    if (failureClass === "DEFINITIVE_REJECT") {
      await releaseGatewayRefundReservation({
        tenantId: payment.tenantId,
        paymentId: payment._id,
        refundId: refund._id,
        amountPaise: refund.amountPaise,
        reviewReason: "REFUND_INITIATION_REJECTED",
      });
      await PaymentRefund.updateOne(
        { _id: refund._id },
        {
          $inc: { providerInitiationAttempts: 1 },
          $set: {
            lastInitiationAt: new Date(),
            providerInitiationError: String(error?.message ?? "rejected").slice(0, 500),
          },
        },
      );
      throw error instanceof Error && error.statusCode
        ? error
        : errors.business("PHONEPE_REFUND_REJECTED", "PhonePe rejected the refund request.", 422);
    }

    await markRefundPendingReconciliation({
      tenantId: payment.tenantId,
      refundId: refund._id,
      providerInitiationError: error?.message,
      attempts,
    });
    if (attempts >= 5) {
      await upsertOperationalAlert({
        tenantId: payment.tenantId,
        type: AlertType.GATEWAY_REFUND_INITIATION_EXHAUSTED,
        entityId: payment._id,
        title: "Gateway refund initiation exhausted",
        message: "Automatic PhonePe refund initiation retries were exhausted; reservation retained for reconciliation.",
        metadata: { refundId: refund._id },
      });
    }
    throw errors.dependency(
      "PhonePe refund initiation failed. Retry with the same idempotency key.",
    );
  }

  const latest = await PaymentRefund.findById(refund._id).lean();
  return { refundId: refund._id, status: latest?.status ?? GatewayRefundStatus.PENDING, reused };
}

export async function releaseAdminPaymentRefundReservation(req) {
  const { reason, evidence, providerConfirmedNotAccepted } = req.body ?? {};
  const trimmedReason = String(reason ?? "").trim();
  if (!trimmedReason) {
    throw errors.business("REFUND_RELEASE_REASON_REQUIRED", "Release reason is required.");
  }
  const refund = await PaymentRefund.findOne({
    _id: req.params.refundId,
    tenantId: req.auth.tenantId,
    paymentId: req.params.paymentId,
  }).lean();
  if (!refund) throw errors.notFound("Refund");
  if (refund.status === GatewayRefundStatus.COMPLETED) {
    throw errors.business("REFUND_ALREADY_COMPLETED", "Completed refunds cannot release reservations.");
  }

  let providerEvidence = providerConfirmedNotAccepted === true;
  if (providerConfirmedNotAccepted === true && !trimmedReason) {
    throw errors.business("REFUND_RELEASE_REASON_REQUIRED", "Release reason is required.");
  }
  if (!providerEvidence) {
    const reconcile = await reconcileGatewayRefundRecord({
      tenantId: req.auth.tenantId,
      refund,
    });
    providerEvidence = reconcile.outcome === "PROVIDER_NOT_FOUND"
      || reconcile.providerState === "FAILED";
    if (reconcile.outcome === "ALREADY_COMPLETED") {
      throw errors.business("REFUND_ALREADY_COMPLETED", "Provider reports refund completed.");
    }
  }

  if (!providerEvidence) {
    throw errors.business(
      "REFUND_RELEASE_NOT_ALLOWED",
      "Release requires provider proof the refund was never accepted, or set providerConfirmedNotAccepted with documented evidence.",
    );
  }

  await releaseGatewayRefundReservation({
    tenantId: req.auth.tenantId,
    paymentId: req.params.paymentId,
    refundId: refund._id,
    amountPaise: refund.amountPaise,
    reviewReason: "MANUAL_RESERVATION_RELEASE",
  });
  await writeAudit({
    req,
    action: "GATEWAY_REFUND_RESERVATION_RELEASED",
    entityType: AuditEntityType.PAYMENT,
    entityId: req.params.paymentId,
    after: { refundId: refund._id, reason: trimmedReason, evidence: evidence ?? null },
  });
  const payment = await Payment.findById(req.params.paymentId).lean();
  return {
    refundId: refund._id,
    status: GatewayRefundStatus.FAILED,
    gatewayRefundReservedPaise: payment?.gatewayRefundReservedPaise ?? 0,
  };
}

export async function listPaymentRefunds(req) {
  const rows = await PaymentRefund.find({
    tenantId: req.auth.tenantId,
    paymentId: req.params.paymentId,
  })
    .sort({ createdAt: -1 })
    .lean();
  return rows.map((row) => ({
    id: row._id,
    paymentId: row.paymentId,
    amountPaise: row.amountPaise,
    status: row.status,
    providerRefundId: row.providerRefundId,
    completedAt: row.completedAt,
    failedAt: row.failedAt,
    requiresReview: row.requiresReview,
    reviewReason: row.reviewReason,
    reason: row.reason,
    providerInitiationError: row.providerInitiationError ?? null,
    providerInitiationAttempts: row.providerInitiationAttempts ?? 0,
  }));
}
