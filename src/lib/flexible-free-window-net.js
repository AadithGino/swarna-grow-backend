/**
 * Net free-phase contribution from ledger truth (payments minus reversals).
 */
export function summarizeFreeWindowLedgerNet(entries) {
  return analyzeFreeWindowLedgerForCap(entries);
}

/** Detailed free-window ledger analysis for cap computation and lock audit. */
export function analyzeFreeWindowLedgerForCap(entries) {
  const payments = entries.filter((row) => row.type === "FREE_WINDOW_PAYMENT");
  const reversalsByPayment = new Map();
  const reversalLedgerEntryIds = [];

  for (const row of entries) {
    if (row.type !== "REVERSAL" || !row.reversalOf) continue;
    reversalLedgerEntryIds.push(row._id);
    reversalsByPayment.set(
      row.reversalOf,
      (reversalsByPayment.get(row.reversalOf) ?? 0) + Math.max(0, Number(row.amountPaise) || 0),
    );
  }

  let grossSuccessfulFreeWindowTotalPaise = 0;
  let totalReversalAmountPaise = 0;
  let netTotalPaise = 0;
  let originalPositivePaymentCount = 0;
  let netPositivePaymentCount = 0;
  const paymentIds = [];
  const contributingPaymentLedgerEntryIds = [];
  const contributingPaymentIds = [];
  const anomalies = [];

  for (const payment of payments) {
    const originalPaise = Math.max(0, Number(payment.amountPaise) || 0);
    if (originalPaise > 0) originalPositivePaymentCount += 1;
    grossSuccessfulFreeWindowTotalPaise += originalPaise;
    const reversedPaise = reversalsByPayment.get(payment.paymentId) ?? 0;
    totalReversalAmountPaise += Math.min(reversedPaise, originalPaise);
    const netPaise = originalPaise - reversedPaise;
    if (netPaise < 0) {
      anomalies.push({ paymentId: payment.paymentId, originalPaise, reversedPaise });
      continue;
    }
    if (netPaise > 0) {
      netTotalPaise += netPaise;
      netPositivePaymentCount += 1;
      if (payment.paymentId) {
        paymentIds.push(payment.paymentId);
        contributingPaymentIds.push(payment.paymentId);
      }
      if (payment._id) contributingPaymentLedgerEntryIds.push(payment._id);
    }
  }

  return {
    grossSuccessfulFreeWindowTotalPaise,
    totalReversalAmountPaise,
    netTotalPaise,
    netFreeTotalPaise: netTotalPaise,
    originalPositivePaymentCount,
    netPositivePaymentCount,
    paymentIds,
    contributingPaymentIds,
    contributingPaymentLedgerEntryIds,
    reversalLedgerEntryIds,
    anomalies,
  };
}
