import { GatewayRefundStatus } from "../constants/enums.js";
import { phonePeProvider, resolvePhonePeCredentials } from "../integrations/phonepe.provider.js";
import { ResourceNotFound } from "@phonepe-pg/pg-sdk-node";
import { errors } from "../lib/app-error.js";
import { Payment, PaymentIntent, PaymentRefund, Tenant } from "../models/index.js";
import { processPhonePeRefundWebhook } from "./phonepe-refund.service.js";

function normalizeProviderRefundState(raw) {
  const state = String(raw?.state ?? raw?.status ?? "PENDING").toUpperCase();
  if (state.includes("COMPLET")) return "COMPLETED";
  if (state.includes("FAIL")) return "FAILED";
  if (state.includes("ACCEPT")) return "ACCEPTED";
  return "PENDING";
}

export async function reconcileGatewayRefundById(req) {
  const refund = await PaymentRefund.findOne({
    _id: req.params.refundId,
    tenantId: req.auth.tenantId,
    paymentId: req.params.paymentId,
  }).lean();
  if (!refund) throw errors.notFound("Refund");
  return reconcileGatewayRefundRecord({ tenantId: req.auth.tenantId, refund });
}

export async function reconcileGatewayRefundRecord({ tenantId, refund }) {
  if (refund.status === GatewayRefundStatus.COMPLETED) {
    return { outcome: "ALREADY_COMPLETED", refundId: refund._id, status: refund.status };
  }
  const payment = await Payment.findOne({ _id: refund.paymentId, tenantId }).lean();
  if (!payment) throw errors.notFound("Payment");

  const tenant = await Tenant.findById(tenantId).select("+integrationSecrets").lean();
  const credentials = resolvePhonePeCredentials(tenant);
  if (!credentials) {
    throw errors.business("PAYMENT_GATEWAY_NOT_CONFIGURED", "PhonePe is not configured.");
  }
  const intent = await PaymentIntent.findOne({ tenantId, paymentId: payment._id }).lean();
  const originalMerchantOrderId = intent?._id;
  if (!originalMerchantOrderId) {
    throw errors.business("REFUND_NO_ORDER_REFERENCE", "Payment is missing a PhonePe merchant order reference.");
  }

  let providerStatus;
  try {
    providerStatus = await phonePeProvider.getRefundStatus({
      merchantRefundId: refund._id,
      originalMerchantOrderId,
      credentials,
      tenantId,
    });
  } catch (error) {
    if (error instanceof ResourceNotFound) {
      return { outcome: "PROVIDER_NOT_FOUND", refundId: refund._id, status: refund.status };
    }
    throw error;
  }

  const state = normalizeProviderRefundState(providerStatus);
  const providerRefundId = refund.providerRefundId ?? refund._id;
  const amount = Number(providerStatus?.amount ?? refund.amountPaise ?? 0);

  if (state === "COMPLETED") {
    const result = await processPhonePeRefundWebhook({
      tenantId,
      type: "PG_REFUND_COMPLETED",
      payload: {
        originalMerchantOrderId,
        refundId: providerRefundId,
        amount: amount || refund.amountPaise,
        currency: "INR",
      },
      providerEventId: `reconcile_${refund._id}_${Date.now()}`,
    });
    return { outcome: result.outcome, refundId: refund._id, providerState: state };
  }
  if (state === "FAILED") {
    const result = await processPhonePeRefundWebhook({
      tenantId,
      type: "PG_REFUND_FAILED",
      payload: { originalMerchantOrderId, refundId: providerRefundId },
      providerEventId: `reconcile_fail_${refund._id}_${Date.now()}`,
    });
    return { outcome: result.outcome, refundId: refund._id, providerState: state };
  }
  if (state === "ACCEPTED") {
    await processPhonePeRefundWebhook({
      tenantId,
      type: "PG_REFUND_ACCEPTED",
      payload: { originalMerchantOrderId, refundId: providerRefundId },
      providerEventId: `reconcile_accept_${refund._id}_${Date.now()}`,
    });
  }
  return { outcome: "STILL_PENDING", refundId: refund._id, providerState: state };
}
