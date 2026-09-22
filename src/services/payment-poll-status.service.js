import { AlertType, PaymentMode, PaymentStatus } from "../constants/enums.js";
import { AppError, errors } from "../lib/app-error.js";
import { upsertOperationalAlert } from "../lib/operational-alert.js";
import { Payment, PaymentIntent, Tenant } from "../models/index.js";
import { claimPaymentForReconcile, reconcileGatewayPayment } from "./phonepe-reconcile.service.js";
import { randomToken } from "../lib/crypto.js";
import { resolvePhonePeCredentials } from "../integrations/phonepe.provider.js";
import { phonePeProvider } from "../integrations/phonepe.provider.js";

function normalizePollResult(payment, reconcileResult = {}) {
  return {
    paymentId: payment._id,
    paymentStatus: payment.status,
    providerState: payment.gatewayLastProviderState ?? reconcileResult.providerState ?? null,
    reconciledAt: payment.gatewayLastReconcileAt ?? new Date(),
    outcome: reconcileResult.outcome ?? "ALREADY_TERMINAL",
    requiresReview: Boolean(payment.requiresReview),
    reviewReason: payment.reviewReason ?? null,
  };
}

export async function pollPaymentGatewayStatus(req) {
  const payment = await Payment.findOne({
    _id: req.params.paymentId,
    tenantId: req.auth.tenantId,
    ...(req.scope.branchId ? { branchId: req.scope.branchId } : {}),
  }).lean();
  if (!payment) throw errors.notFound("Payment");
  if (payment.mode !== PaymentMode.ONLINE_GATEWAY) {
    throw errors.business("POLL_STATUS_NOT_GATEWAY", "Poll-status is only available for online gateway payments.");
  }

  if (payment.status === PaymentStatus.SUCCESS || payment.status === PaymentStatus.REVERSED
    || payment.status === PaymentStatus.PARTIALLY_REFUNDED) {
    return normalizePollResult(payment, { outcome: "ALREADY_TERMINAL" });
  }

  const intent = await PaymentIntent.findOne({
    tenantId: payment.tenantId,
    paymentId: payment._id,
  }).lean();
  const merchantOrderId = intent?._id ?? intent?.providerOrderId;
  if (!merchantOrderId) {
    await upsertOperationalAlert({
      tenantId: payment.tenantId,
      type: AlertType.GATEWAY_WEBHOOK_UNMATCHED,
      entityId: payment._id,
      title: "Gateway poll missing order reference",
      message: "Poll-status could not resolve a PhonePe merchant order id for this payment.",
      metadata: { paymentId: payment._id },
    });
    throw errors.business("POLL_STATUS_NO_REFERENCE", "No provider order reference is stored for this payment.");
  }

  const tenant = await Tenant.findById(payment.tenantId).select("+integrationSecrets").lean();
  const credentials = resolvePhonePeCredentials(tenant);
  if (!credentials) {
    throw errors.business("PAYMENT_GATEWAY_NOT_CONFIGURED", "PhonePe is not configured for this tenant.");
  }

  try {
    await phonePeProvider.getOrderStatus(merchantOrderId, credentials, payment.tenantId);
  } catch (error) {
    if (error?.code === "ETIMEDOUT" || error?.message?.toLowerCase?.().includes("timeout")) {
      throw new AppError("PROVIDER_TIMEOUT", "PhonePe did not respond in time. Retry poll-status shortly.", 503);
    }
    if (error?.name === "ResourceNotFound" || error?.code === "RESOURCE_NOT_FOUND") {
      await upsertOperationalAlert({
        tenantId: payment.tenantId,
        type: AlertType.GATEWAY_WEBHOOK_UNMATCHED,
        entityId: payment._id,
        title: "Gateway poll unknown reference",
        message: "PhonePe did not recognize the stored merchant order id.",
        metadata: { paymentId: payment._id, merchantOrderId },
      });
      throw errors.business("POLL_STATUS_UNKNOWN_REFERENCE", "Provider did not recognize the stored order reference.");
    }
  }

  if (payment.status !== PaymentStatus.PENDING) {
    const refreshed = await Payment.findById(payment._id).lean();
    return normalizePollResult(refreshed ?? payment);
  }

  const claimed = await claimPaymentForReconcile({
    paymentId: payment._id,
    tenantId: payment.tenantId,
    workerLabel: `poll_${randomToken(6)}`,
    now: new Date(),
  });
  if (!claimed) {
    throw new AppError("POLL_STATUS_BUSY", "Another reconciliation is in progress. Retry shortly.", 503);
  }

  let reconcileResult;
  try {
    reconcileResult = await reconcileGatewayPayment(claimed, { source: "ADMIN_POLL" });
  } catch (error) {
    if (error?.code === "ETIMEDOUT" || error?.message?.toLowerCase?.().includes("timeout")) {
      throw new AppError("PROVIDER_TIMEOUT", "PhonePe did not respond in time. Retry poll-status shortly.", 503);
    }
    throw error;
  }

  const refreshed = await Payment.findById(payment._id).lean();
  return normalizePollResult(refreshed ?? payment, reconcileResult);
}
