import { PaymentPattern } from "../constants/enums.js";
import {
  flexibleContributionCycleCount,
  isFlexibleMaturityOnlyCycleIndex,
} from "./flexible-plan-duration.js";

const SETTLED_INSTALLMENT_STATUSES = new Set(["PAID", "WAIVED"]);

/**
 * Calendar maturity: scheme tenure ended before `asOfYmd` (same boundary as the scheduler query).
 */
export function isCalendarMaturityReached(scheme, asOfYmd) {
  const maturityDate = scheme?.maturityDate;
  if (!maturityDate || !asOfYmd) return false;
  return maturityDate < asOfYmd;
}

/**
 * Contribution / payment completion for normal (non–system-policy) maturity and redemption.
 */
export function assessMaturityContributionEligibility(scheme) {
  const pattern = scheme.paymentPattern ?? scheme.planSnapshot?.paymentPattern;
  if (pattern === PaymentPattern.FIXED || pattern === "FIXED") {
    return assessFixedMaturityContributions(scheme);
  }
  if (pattern === PaymentPattern.FLEXIBLE || pattern === "FLEXIBLE") {
    return assessFlexibleMaturityContributions(scheme);
  }
  return {
    paymentEligible: false,
    contributionEligible: false,
    reason: "UNSUPPORTED_PAYMENT_PATTERN",
  };
}

function assessFixedMaturityContributions(scheme) {
  const installments = scheme.installments ?? [];
  if (!installments.length) {
    return {
      paymentEligible: false,
      contributionEligible: false,
      reason: "INSTALLMENTS_INCOMPLETE",
      message: "Required instalments are not complete.",
    };
  }
  const incomplete = installments.filter(
    (row) => !SETTLED_INSTALLMENT_STATUSES.has(row.status),
  );
  if (incomplete.length) {
    return {
      paymentEligible: false,
      contributionEligible: false,
      reason: "INSTALLMENTS_INCOMPLETE",
      message: "Required instalments are not complete.",
      incompleteCount: incomplete.length,
    };
  }
  return {
    paymentEligible: true,
    contributionEligible: true,
    reason: null,
    message: null,
  };
}

function assessFlexibleMaturityContributions(scheme) {
  const plan = scheme.planSnapshot ?? {};
  const cycles = scheme.cycles ?? [];
  const contributionMonths = flexibleContributionCycleCount(plan);
  for (let index = 0; index < contributionMonths; index += 1) {
    if (isFlexibleMaturityOnlyCycleIndex(index, plan)) continue;
    const cycle = cycles[index];
    const capPaise = Number(cycle?.capPaise ?? 0);
    if (capPaise <= 0) continue;
    const paidPaise = Number(cycle?.paidPaise ?? 0);
    if (paidPaise < capPaise) {
      return {
        paymentEligible: false,
        contributionEligible: false,
        reason: "FLEX_CYCLE_INCOMPLETE",
        message: "Required contribution cycles are not complete.",
        cycleIndex: index,
        cycle: cycle?.cycle ?? null,
      };
    }
  }
  return {
    paymentEligible: true,
    contributionEligible: true,
    reason: null,
    message: null,
  };
}

/** Combined calendar + contribution eligibility for normal maturity transition. */
export function assessNormalMaturityTransitionEligibility(scheme, asOfYmd) {
  const calendarEligible = isCalendarMaturityReached(scheme, asOfYmd);
  const contribution = assessMaturityContributionEligibility(scheme);
  return {
    calendarEligible,
    ...contribution,
    eligible: calendarEligible && contribution.paymentEligible,
  };
}
