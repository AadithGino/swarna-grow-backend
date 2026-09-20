/**
 * Required provider fields before treating an order as COMPLETED for local finalization.
 * Never substitute local payment fields for missing provider data.
 */
export function validatePhonePeCompletedIdentifiers({ merchantOrderId, normalized }) {
  const reference = String(merchantOrderId ?? "").trim();
  if (!reference) {
    return { ok: false, code: "MISSING_MERCHANT_ORDER_ID" };
  }
  const transactionId = normalized?.transactionId;
  if (!transactionId || !String(transactionId).trim()) {
    return { ok: false, code: "MISSING_TRANSACTION_ID" };
  }
  const amountPaise = Number(normalized?.amount);
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
    return { ok: false, code: "MISSING_OR_INVALID_AMOUNT" };
  }
  return {
    ok: true,
    merchantOrderId: reference,
    transactionId: String(transactionId).trim(),
    amountPaise,
  };
}
