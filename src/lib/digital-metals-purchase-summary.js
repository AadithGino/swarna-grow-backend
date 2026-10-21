/** Customer-facing purchase receipt fields (buy order + optional payment attempt). */
export function buildDigitalMetalPurchaseSummary(order, paymentAttempt = null) {
  if (!order) return null;
  const snapshot = order.snapshot && typeof order.snapshot === "object" ? order.snapshot : {};
  const rateSnapshot =
    snapshot.rateSnapshot && typeof snapshot.rateSnapshot === "object" ? snapshot.rateSnapshot : {};
  const bookedAt = order.termsAcceptedAt ?? order.createdAt ?? null;
  const creditedAt = order.creditedAt ?? null;
  const attempt = paymentAttempt ?? null;
  return {
    orderId: order._id,
    metal: order.metal,
    finenessPpm: order.finenessPpm,
    quantityUg: String(order.quantityUg),
    totalPayablePaise: order.totalPayablePaise,
    buyRatePerGramPaise: rateSnapshot.buyRatePerGramPaise ?? null,
    rateVersionId: rateSnapshot.rateVersionId ?? null,
    bookedAt: bookedAt ? new Date(bookedAt).toISOString() : null,
    creditedAt: creditedAt ? new Date(creditedAt).toISOString() : null,
    payment: attempt
      ? {
          attemptId: attempt._id,
          status: attempt.status,
          amountPaise: attempt.amountPaise,
          provider: attempt.provider ?? "PHONEPE",
          merchantOrderId: attempt.merchantOrderId ?? attempt._id,
          providerPaymentId: attempt.providerPaymentId ?? null,
          paidAt: attempt.updatedAt ? new Date(attempt.updatedAt).toISOString() : null,
        }
      : null,
  };
}

export function purchaseSummaryForJournalMetadata(order, paymentAttempt) {
  const summary = buildDigitalMetalPurchaseSummary(order, paymentAttempt);
  if (!summary) return null;
  return {
    kind: "PURCHASE",
    ...summary,
  };
}
