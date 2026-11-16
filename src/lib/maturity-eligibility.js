import { maturityGoldRules } from "./maturity-gold-benefit.js";
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
  const maturityRule = scheme.collectionFrequency && scheme.planSnapshot?.collectionRules?.maturityRule;
  return maturityRule && maturityRule !== "CALENDAR_MONTH_END"
    ? maturityDate <= asOfYmd
    : maturityDate < asOfYmd;
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
  if (maturityGoldRules(scheme.planSnapshot)?.requireAllCollections === false) {
    const funded = installments.some((row) => row.paidPaise > 0);
    return { paymentEligible: funded, contributionEligible: funded, reason: funded ? null : "INSTALLMENTS_INCOMPLETE" };
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
    const netContributedPaise = Math.max(0, Number(cycle?.paidPaise ?? 0));
    if (netContributedPaise <= 0) {
      return {
        paymentEligible: false,
        contributionEligible: false,
        reason: "FLEX_CYCLE_NO_NET_CONTRIBUTION",
        message: "Each required capped cycle must have a net-positive contribution.",
        cycleIndex: index,
        cycle: cycle?.cycle ?? null,
        netContributedPaise,
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
  const pattern = scheme.paymentPattern ?? scheme.planSnapshot?.paymentPattern;
  const allowsIncompleteFixedSchedule = pattern === PaymentPattern.FIXED &&
    maturityGoldRules(scheme.planSnapshot)?.requireAllCollections === false;
  const gracePending = Boolean(scheme.collectionFrequency || allowsIncompleteFixedSchedule) && (scheme.installments ?? []).some(
    (row) => !SETTLED_INSTALLMENT_STATUSES.has(row.status) && row.graceEndsAt && asOfYmd <= row.graceEndsAt,
  );
  return {
    calendarEligible,
    ...contribution,
    ...(gracePending ? { gracePending } : {}),
    eligible: calendarEligible && contribution.paymentEligible && !gracePending,
  };
}
