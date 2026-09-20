/**
 * Normalize PhonePe SDK order status for reconciliation (not webhook callbacks).
 */
export const PhonePeOrderStatusKind = Object.freeze({
  COMPLETED: "COMPLETED",
  TERMINAL_FAILED: "TERMINAL_FAILED",
  PENDING: "PENDING",
});

const TERMINAL_FAIL_STATES = new Set(["FAILED", "EXPIRED", "CANCELLED", "DECLINED"]);
const COMPLETED_STATES = new Set(["COMPLETED", "SUCCESS", "PAID"]);

export function pickPhonePeTransactionId(paymentDetails = []) {
  const rows = Array.isArray(paymentDetails) ? paymentDetails : [];
  const completed = rows.find((row) => String(row?.state ?? "").toUpperCase() === "COMPLETED");
  const pick = completed ?? rows[0];
  return pick?.transactionId ?? null;
}

export function normalizePhonePeOrderStatus(response = {}) {
  const state = String(response?.state ?? "").toUpperCase();
  const paymentDetails = response?.paymentDetails ?? [];
  const transactionId = pickPhonePeTransactionId(paymentDetails);
  const amount = Number(response?.amount ?? response?.payableAmount ?? 0);

  if (COMPLETED_STATES.has(state)) {
    return {
      kind: PhonePeOrderStatusKind.COMPLETED,
      state,
      amount,
      transactionId,
      raw: response,
    };
  }
  if (TERMINAL_FAIL_STATES.has(state)) {
    return {
      kind: PhonePeOrderStatusKind.TERMINAL_FAILED,
      state,
      amount,
      transactionId,
      raw: response,
    };
  }
  return {
    kind: PhonePeOrderStatusKind.PENDING,
    state: state || "UNKNOWN",
    amount,
    transactionId,
    raw: response,
  };
}
