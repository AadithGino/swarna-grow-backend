import { CapFormula } from "../constants/enums.js";

/** Divisor for monthly cap: plan averaging divisor or count of free-window payments. */
export function flexibleCapDivisor(flexibleRules, freeWindowPaymentCount) {
  const formula =
    flexibleRules?.capComputation?.formula ??
    CapFormula.FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR;
  if (formula === CapFormula.FLEXIBLE_PHASE_TOTAL_DIV_PAYMENT_COUNT) {
    return Math.max(1, freeWindowPaymentCount);
  }
  const freeMonths = flexibleRules?.flexiblePhaseCycles ?? 6;
  return Math.max(1, flexibleRules?.averagingDivisor ?? freeMonths);
}

/** Compute capped-phase monthly allowance from free-window ledger total (paise). */
export function computeFlexibleCycleCapPaise({
  totalPaise,
  freeWindowPaymentCount,
  flexibleRules,
}) {
  const capRules = flexibleRules?.capComputation ?? {};
  const nearest = Math.max(1, capRules.roundToNearestPaise ?? 100);
  const divisor = flexibleCapDivisor(flexibleRules, freeWindowPaymentCount);
  let capPaise = Math.ceil(totalPaise / divisor / nearest) * nearest;
  const minTotal = flexibleRules?.flexiblePhase?.minTotalPaise;
  if (
    minTotal != null &&
    totalPaise < minTotal &&
    capRules.onBelowMinimumTotal === "USE_MINIMUM"
  ) {
    capPaise = capRules.minCycleCapPaise ?? capPaise;
  }
  const minCap = capRules.minCycleCapPaise ?? 0;
  const maxCap = capRules.maxCycleCapPaise ?? capPaise;
  return Math.min(maxCap, Math.max(minCap, capPaise));
}
