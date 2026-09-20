import { CapFormula, CapRoundingMode } from "../constants/enums.js";
import { flexibleCapDivisor } from "./flexible-cap-divisor.js";

export { flexibleCapDivisor } from "./flexible-cap-divisor.js";

function roundCapQuotient(unroundedCapPaise, nearest, roundingMode) {
  const increment = Math.max(1, nearest);
  const quotient = unroundedCapPaise / increment;
  if (roundingMode === CapRoundingMode.ROUND_UP || roundingMode === "ROUND_UP") {
    return Math.ceil(quotient) * increment;
  }
  if (roundingMode === "ROUND_DOWN") {
    return Math.floor(quotient) * increment;
  }
  if (roundingMode === "HALF_UP") {
    return Math.round(quotient) * increment;
  }
  return Math.ceil(quotient) * increment;
}

/**
 * Pure cap calculation shared by preview, lock, and tests.
 * `netSummary` matches analyzeFreeWindowLedgerForCap output shape (or illustrative equivalents).
 */
export function computeFlexibleLockCapDetails({
  netSummary,
  flexibleRules,
  freePhaseBoundary = null,
  lockedAt = null,
}) {
  const capRules = flexibleRules?.capComputation ?? {};
  const formula =
    capRules.formula ?? CapFormula.FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR;
  const roundingMode = capRules.roundingMode ?? CapRoundingMode.ROUND_UP;
  const roundToNearestPaise = Math.max(1, capRules.roundToNearestPaise ?? 100);
  const configuredAveragingDivisor = Math.max(
    1,
    flexibleRules?.averagingDivisor
      ?? flexibleRules?.flexiblePhaseCycles
      ?? 6,
  );
  const netFreeTotalPaise = netSummary.netFreeTotalPaise ?? netSummary.netTotalPaise ?? 0;
  const netPositivePaymentCount = netSummary.netPositivePaymentCount ?? 0;
  const actualDivisor = flexibleCapDivisor(flexibleRules, netPositivePaymentCount);
  const unroundedQuotient = actualDivisor > 0 ? netFreeTotalPaise / actualDivisor : 0;
  let roundedBeforeClamp = roundCapQuotient(
    unroundedQuotient,
    roundToNearestPaise,
    roundingMode,
  );
  const minTotal = flexibleRules?.flexiblePhase?.minTotalPaise;
  if (
    minTotal != null
    && netFreeTotalPaise < minTotal
    && capRules.onBelowMinimumTotal === "USE_MINIMUM"
  ) {
    roundedBeforeClamp = capRules.minCycleCapPaise ?? roundedBeforeClamp;
  }
  const minimumFloor = capRules.minCycleCapPaise ?? 0;
  const maximumCeiling = capRules.maxCycleCapPaise ?? roundedBeforeClamp;
  const afterFloor = Math.max(minimumFloor, roundedBeforeClamp);
  const finalCapPaise = Math.min(maximumCeiling, afterFloor);

  return {
    capPaise: finalCapPaise,
    audit: {
      formula,
      grossSuccessfulFreeWindowTotalPaise:
        netSummary.grossSuccessfulFreeWindowTotalPaise ?? netFreeTotalPaise,
      totalReversalAmountPaise: netSummary.totalReversalAmountPaise ?? 0,
      netFreeTotalPaise,
      originalPositivePaymentCount: netSummary.originalPositivePaymentCount ?? netPositivePaymentCount,
      netPositivePaymentCount,
      configuredAveragingDivisor,
      actualDivisorUsed: actualDivisor,
      unroundedQuotient,
      roundingMode,
      roundToNearestPaise,
      roundedBeforeClamp,
      minimumFloor,
      maximumCeiling,
      finalCapPaise,
      contributingPaymentIds: netSummary.contributingPaymentIds ?? netSummary.paymentIds ?? [],
      contributingPaymentLedgerEntryIds:
        netSummary.contributingPaymentLedgerEntryIds ?? [],
      reversalLedgerEntryIds: netSummary.reversalLedgerEntryIds ?? [],
      freePhaseBoundary,
      lockedAt: lockedAt ?? undefined,
    },
  };
}

/** Illustrative preview inputs (no ledger rows yet). */
export function buildIllustrativeFreeWindowNetSummary({
  installmentAmountPaise,
  flexiblePhaseCycles,
  paymentCount = null,
}) {
  const cycles = flexiblePhaseCycles ?? 6;
  const count = paymentCount ?? cycles;
  const gross = installmentAmountPaise * cycles;
  return {
    grossSuccessfulFreeWindowTotalPaise: gross,
    totalReversalAmountPaise: 0,
    netFreeTotalPaise: gross,
    netTotalPaise: gross,
    originalPositivePaymentCount: count,
    netPositivePaymentCount: count,
    paymentIds: [],
    contributingPaymentIds: [],
    contributingPaymentLedgerEntryIds: [],
    reversalLedgerEntryIds: [],
    anomalies: [],
  };
}

/** Compute capped-phase monthly allowance from free-window ledger total (paise). */
export function computeFlexibleCycleCapPaise({
  totalPaise,
  freeWindowPaymentCount,
  flexibleRules,
}) {
  return computeFlexibleLockCapDetails({
    netSummary: {
      netFreeTotalPaise: totalPaise,
      netTotalPaise: totalPaise,
      netPositivePaymentCount: freeWindowPaymentCount,
      grossSuccessfulFreeWindowTotalPaise: totalPaise,
      totalReversalAmountPaise: 0,
      originalPositivePaymentCount: freeWindowPaymentCount,
    },
    flexibleRules,
  }).capPaise;
}
