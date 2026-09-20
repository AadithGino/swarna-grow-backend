import { CapFormula } from "../constants/enums.js";

/** Divisor for monthly cap: plan averaging divisor or count of free-window payments. */
export function flexibleCapDivisor(flexibleRules, freeWindowPaymentCount) {
  const formula =
    flexibleRules?.capComputation?.formula
    ?? CapFormula.FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR;
  if (formula === CapFormula.FLEXIBLE_PHASE_TOTAL_DIV_PAYMENT_COUNT) {
    return Math.max(1, freeWindowPaymentCount);
  }
  const freeMonths = flexibleRules?.flexiblePhaseCycles ?? 6;
  return Math.max(1, flexibleRules?.averagingDivisor ?? freeMonths);
}
