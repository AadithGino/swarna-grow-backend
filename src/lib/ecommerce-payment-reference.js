export function isEcommercePaymentMerchantOrderId(reference) {
  return String(reference ?? "").startsWith("epay_");
}

export function isEcommercePaymentExceptionRefundMerchantId(reference) {
  return String(reference ?? "").startsWith("epayref_");
}

export function isEcommercePhonePeRefundPayload(payload = {}) {
  const original =
    payload.originalMerchantOrderId
    ?? payload.merchantOrderId
    ?? null;
  const refundRef = payload.refundId ?? payload.merchantRefundId ?? null;
  return (
    isEcommercePaymentMerchantOrderId(original)
    || isEcommercePaymentExceptionRefundMerchantId(refundRef)
  );
}
