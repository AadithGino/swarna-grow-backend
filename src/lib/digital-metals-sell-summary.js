/** Customer- and admin-facing sell receipt fields (order + masked bank destination). */
export function buildDigitalMetalSellSummary(order, bankDestination = null) {
  if (!order) return null;
  const snapshot = order.snapshot && typeof order.snapshot === "object" ? order.snapshot : {};
  const rateSnapshot =
    snapshot.rateSnapshot && typeof snapshot.rateSnapshot === "object" ? snapshot.rateSnapshot : {};
  const bank = bankDestination
    ? {
        id: bankDestination.id ?? bankDestination.destinationId ?? null,
        accountHolderName: bankDestination.accountHolderName ?? "",
        accountLast4: bankDestination.accountLast4 ?? "",
        ifsc: bankDestination.ifsc ?? "",
        bankName: bankDestination.bankName ?? "",
        status: bankDestination.status ?? bankDestination.verificationStatus ?? null,
        verifiedAt: bankDestination.verifiedAt
          ? new Date(bankDestination.verifiedAt).toISOString()
          : null,
      }
    : null;
  return {
    orderId: order._id,
    metal: order.metal,
    finenessPpm: order.finenessPpm,
    quantityUg: String(order.quantityUg),
    settlementPaise: order.settlementPaise,
    sellRatePerGramPaise: rateSnapshot.sellRatePerGramPaise ?? null,
    rateVersionId: rateSnapshot.rateVersionId ?? null,
    confirmedAt: order.confirmedAt ? new Date(order.confirmedAt).toISOString() : null,
    executedAt: order.executedAt ? new Date(order.executedAt).toISOString() : null,
    bankDestination: bank,
  };
}

export function sellSummaryForJournalMetadata(order, bankDestination = null) {
  const summary = buildDigitalMetalSellSummary(order, bankDestination);
  if (!summary) return null;
  return {
    kind: "SELL",
    ...summary,
  };
}
