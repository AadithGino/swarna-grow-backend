const REDEMPTION_STATUS_RANK = Object.freeze({
  CHARGE_PENDING: 10,
  CHARGE_PAID: 20,
  FULFILMENT_ACCEPTED: 30,
  PACKING: 40,
  DISPATCHED: 50,
  PICKUP_READY: 50,
  /** Customer notice only — order status remains DISPATCHED after replacement shipment. */
  REPLACEMENT_DISPATCHED: 50,
  INVESTIGATION: 55,
  COMPLETED: 60,
  CANCELLED: 70,
  EXPIRED: 80,
});

export function redemptionTransitionRank(status) {
  return REDEMPTION_STATUS_RANK[String(status ?? "").toUpperCase()] ?? -1;
}

export function compareRedemptionTransition(expectedTransition, actualStatus) {
  const expected = redemptionTransitionRank(expectedTransition);
  const actual = redemptionTransitionRank(actualStatus);
  if (expected < 0 || actual < 0) return "UNKNOWN";
  if (actual === expected) return "MATCH";
  if (actual > expected) return "SUPERSEDED";
  return "DELAYED";
}
