import { env } from "../config/env.js";
import { PhonePeOrderStatusKind, normalizePhonePeOrderStatus } from "./phonepe-order-status.js";
import { phonePeProvider, resolvePhonePeCredentials } from "../integrations/phonepe.provider.js";
import { Tenant } from "../models/index.js";
import { resolveMerchantOrderIdForPayment } from "../services/phonepe-reconcile.service.js";

export const PhonePeExpiryDecision = Object.freeze({
  FINALIZE_SUCCESS: "FINALIZE_SUCCESS",
  TERMINAL_FAIL: "TERMINAL_FAIL",
  DEFER: "DEFER",
  TRANSIENT_ERROR: "TRANSIENT_ERROR",
});

/**
 * Provider truth for expiry/reconcile — never maps uncertain responses to terminal failure.
 */
export async function resolvePhonePeExpiryDecision(payment) {
  const merchantOrderId = await resolveMerchantOrderIdForPayment(payment);
  if (!merchantOrderId) {
    return { decision: PhonePeExpiryDecision.DEFER, reason: "NO_MERCHANT_ORDER_ID" };
  }
  const tenant = await Tenant.findById(payment.tenantId).select("+integrationSecrets").lean();
  const credentials = resolvePhonePeCredentials(tenant);
  if (!credentials && env.PROVIDER_MODE !== "mock") {
    return { decision: PhonePeExpiryDecision.TRANSIENT_ERROR, reason: "NO_CREDENTIALS" };
  }
  let orderResponse;
  try {
    orderResponse = await phonePeProvider.getOrderStatus(
      merchantOrderId,
      credentials,
      payment.tenantId,
    );
  } catch (error) {
    return { decision: PhonePeExpiryDecision.TRANSIENT_ERROR, reason: error.message };
  }
  const normalized = normalizePhonePeOrderStatus(orderResponse);
  if (normalized.kind === PhonePeOrderStatusKind.COMPLETED) {
    const amountPaise = Number(normalized.amount);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
      return { decision: PhonePeExpiryDecision.DEFER, reason: "COMPLETED_WITHOUT_AMOUNT" };
    }
    return {
      decision: PhonePeExpiryDecision.FINALIZE_SUCCESS,
      merchantOrderId,
      amountPaise,
      transactionId: normalized.transactionId,
      providerPayload: { source: "EXPIRE_JOB", orderStatus: normalized.raw },
    };
  }
  if (normalized.kind === PhonePeOrderStatusKind.TERMINAL_FAILED) {
    return {
      decision: PhonePeExpiryDecision.TERMINAL_FAIL,
      merchantOrderId,
      transactionId: normalized.transactionId,
      providerPayload: { source: "EXPIRE_JOB", orderStatus: normalized.raw },
    };
  }
  return { decision: PhonePeExpiryDecision.DEFER, reason: "PROVIDER_PENDING", providerState: normalized.state };
}
