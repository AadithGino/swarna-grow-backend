import { AuditEntityType, AlertType, GatewayRefundStatus, PaymentMode, PaymentStatus } from "../constants/enums.js";
import { phonePeProvider, resolvePhonePeCredentials } from "../integrations/phonepe.provider.js";
import { createId } from "../lib/ids.js";
import { upsertOperationalAlert } from "../lib/operational-alert.js";
import { withTransaction } from "../lib/transaction.js";
import { errors } from "../lib/app-error.js";
import { Payment, PaymentIntent, PaymentRefund, Tenant } from "../models/index.js";
import { writeAudit } from "./audit.service.js";

const REFUNDABLE = new Set([PaymentStatus.SUCCESS, PaymentStatus.PARTIALLY_REFUNDED]);

export async function initiateAdminPaymentRefund(req) {
  const { amountPaise, reason } = req.body ?? {};
  if (!reason || !String(reason).trim()) {
    throw errors.business("REFUND_REASON_REQUIRED", "Refund reason is required.");
  }
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw errors.business("REFUND_AMOUNT_INVALID", "amountPaise must be a positive safe integer.");
  }

  const payment = await Payment.findOne({
    _id: req.params.paymentId,
    tenantId: req.auth.tenantId,
    ...(req.scope.branchId ? { branchId: req.scope.branchId } : {}),
  });
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

  const remaining = payment.amountPaise - (payment.refundedAmountPaise ?? 0);
  if (amountPaise > remaining) {
    throw errors.business("REFUND_AMOUNT_EXCEEDS_REMAINING", "Refund amount exceeds remaining refundable balance.");
  }

  const idempotencyKey = req.headers["x-idempotency-key"];
  if (!idempotencyKey) {
    throw errors.business("IDEMPOTENCY_KEY_REQUIRED", "x-idempotency-key header is required.");
  }

  let existing = await PaymentRefund.findOne({
    tenantId: payment.tenantId,
    paymentId: payment._id,
    idempotencyKey,
  }).lean();
  if (existing) {
    return { refundId: existing._id, status: existing.status, reused: true };
  }

  const merchantRefundId = createId("pref");
  const intent = await PaymentIntent.findOne({
    tenantId: payment.tenantId,
    paymentId: payment._id,
  }).lean();
  const originalMerchantOrderId = intent?._id;
  if (!originalMerchantOrderId) {
    throw errors.business("REFUND_NO_ORDER_REFERENCE", "Payment is missing a PhonePe merchant order reference.");
  }

  let refund;
  await withTransaction(async (session) => {
    refund = await PaymentRefund.create(
      [
        {
          _id: merchantRefundId,
          tenantId: payment.tenantId,
          paymentId: payment._id,
          providerRefundId: merchantRefundId,
          amountPaise,
          status: GatewayRefundStatus.PENDING,
          idempotencyKey,
          reason: String(reason).trim(),
          initiatedBy: req.auth.id,
          providerInitiationAttempts: 0,
        },
      ],
      { session },
    );
    refund = refund[0];
    await writeAudit({
      req,
      action: "GATEWAY_REFUND_INITIATED",
      entityType: AuditEntityType.PAYMENT,
      entityId: payment._id,
      after: { refundId: refund._id, amountPaise },
      metadata: { idempotencyKey },
      session,
    });
  });

  const tenant = await Tenant.findById(payment.tenantId).select("+integrationSecrets").lean();
  const credentials = resolvePhonePeCredentials(tenant);
  if (!credentials) {
    throw errors.business("PAYMENT_GATEWAY_NOT_CONFIGURED", "PhonePe is not configured.");
  }

  try {
    await phonePeProvider.initiateRefund({
      merchantRefundId,
      originalMerchantOrderId,
      amountPaise,
      credentials,
      tenantId: payment.tenantId,
    });
    await PaymentRefund.updateOne(
      { _id: refund._id },
      { $inc: { providerInitiationAttempts: 1 }, $set: { lastInitiationAt: new Date() } },
    );
  } catch (error) {
    await PaymentRefund.updateOne(
      { _id: refund._id },
      {
        $inc: { providerInitiationAttempts: 1 },
        $set: {
          lastInitiationAt: new Date(),
          providerInitiationError: String(error?.message ?? "initiation_failed").slice(0, 500),
        },
      },
    );
    if ((refund.providerInitiationAttempts ?? 0) + 1 >= 5) {
      await upsertOperationalAlert({
        tenantId: payment.tenantId,
        type: AlertType.GATEWAY_REFUND_INITIATION_EXHAUSTED,
        entityId: payment._id,
        title: "Gateway refund initiation exhausted",
        message: "Automatic PhonePe refund initiation retries were exhausted.",
        metadata: { refundId: refund._id },
      });
    }
    throw errors.business("REFUND_INITIATION_FAILED", "PhonePe refund initiation failed. Retry with the same idempotency key.", 503);
  }

  return { refundId: refund._id, status: GatewayRefundStatus.PENDING, reused: false };
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
  }));
}
