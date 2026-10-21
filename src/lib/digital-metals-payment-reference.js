export function isDigitalMetalBuyPaymentMerchantOrderId(reference) {
  return String(reference ?? "").startsWith("dmpay_");
}

export function isDigitalMetalRedemptionChargeMerchantOrderId(reference) {
  return String(reference ?? "").startsWith("dmrpay_");
}

export function isDigitalMetalPaymentExceptionRefundMerchantId(reference) {
  return String(reference ?? "").startsWith("dmref_");
}

export function isDigitalMetalRedemptionChargeRefundMerchantId(reference) {
  return String(reference ?? "").startsWith("dmrref_");
}

export function isDigitalMetalBuyPhonePeRefundPayload(payload = {}) {
  const refundRef = payload.refundId ?? payload.merchantRefundId ?? null;
  if (isDigitalMetalPaymentExceptionRefundMerchantId(refundRef)) return true;
  const original =
    payload.originalMerchantOrderId
    ?? payload.merchantOrderId
    ?? null;
  return isDigitalMetalBuyPaymentMerchantOrderId(original);
}
