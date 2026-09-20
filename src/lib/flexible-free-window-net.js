/**
 * Net free-phase contribution from ledger truth (payments minus reversals).
 */
export function summarizeFreeWindowLedgerNet(entries) {
  const payments = entries.filter((row) => row.type === "FREE_WINDOW_PAYMENT");
  const reversalsByPayment = new Map();
  for (const row of entries) {
    if (row.type !== "REVERSAL" || !row.reversalOf) continue;
    reversalsByPayment.set(
      row.reversalOf,
      (reversalsByPayment.get(row.reversalOf) ?? 0) + Math.max(0, Number(row.amountPaise) || 0),
    );
  }

  let netTotalPaise = 0;
  let netPositivePaymentCount = 0;
  const paymentIds = [];
  const anomalies = [];

  for (const payment of payments) {
    const originalPaise = Math.max(0, Number(payment.amountPaise) || 0);
    const reversedPaise = reversalsByPayment.get(payment.paymentId) ?? 0;
    const netPaise = originalPaise - reversedPaise;
    if (netPaise < 0) {
      anomalies.push({ paymentId: payment.paymentId, originalPaise, reversedPaise });
      continue;
    }
    if (netPaise > 0) {
      netTotalPaise += netPaise;
      netPositivePaymentCount += 1;
      if (payment.paymentId) paymentIds.push(payment.paymentId);
    }
  }

  return {
    netTotalPaise,
    netPositivePaymentCount,
    paymentIds,
    anomalies,
  };
}
