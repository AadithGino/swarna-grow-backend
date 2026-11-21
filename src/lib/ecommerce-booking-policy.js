import { AppError } from "./app-error.js";
import { mulDivHalfUpPaise } from "./ecommerce-exact-money.js";
import { buildSavedRateOption } from "./ecommerce-pricing.js";
import { EcommerceBookingAdvanceMode, EcommerceBookingRateRule } from "../constants/enums.js";

const MINUTE = 60_000;
const HOUR = 3_600_000;

/**
 * Which assignment applies. Product beats category beats the pickup branch's default, and an
 * assignment that switches booking off ends the search at its own level: a product-level "off"
 * therefore wins even when its category or branch has a policy.
 *
 * @returns {{ enabled: true, assignment: object } | { enabled: false, reason: string }}
 */
export function pickPolicyAssignment({ product = null, category = null, branch = null }) {
  for (const [level, assignment] of [["PRODUCT", product], ["CATEGORY", category], ["BRANCH", branch]]) {
    if (!assignment || assignment.active === false) continue;
    if (!assignment.bookingEnabled) return { enabled: false, reason: `${level}_OFF` };
    return { enabled: true, assignment };
  }
  return { enabled: false, reason: "NO_POLICY" };
}

/** A policy with no branch list is usable at every branch; otherwise the branch must be listed. */
export function assertBranchEligible(policy, pickupBranchId) {
  const allowed = policy?.eligiblePickupBranchIds ?? [];
  if (!pickupBranchId || (allowed.length && !allowed.includes(pickupBranchId))) {
    throw new AppError("BOOKING_BRANCH_NOT_ELIGIBLE", "This booking policy cannot be used at the selected branch.", 422, {
      pickupBranchId: pickupBranchId ?? null,
    });
  }
}

/**
 * The advance for an estimated total, in whole paise. A percentage advance is rounded half up and
 * raised to the policy floor; every advance is capped at the total, because an advance above the
 * price of the ornament would only ever be refunded.
 */
export function computeAdvancePaise(policy, estimatedTotalPaise) {
  if (!Number.isSafeInteger(estimatedTotalPaise) || estimatedTotalPaise < 1) {
    throw new AppError("BOOKING_ESTIMATE_INVALID", "The estimated total must be a positive whole number of paise.", 422);
  }
  const advance = policy?.advance ?? {};
  let paise;
  if (advance.mode === EcommerceBookingAdvanceMode.PERCENT) {
    if (!Number.isInteger(advance.percentBps) || advance.percentBps < 1) {
      throw new AppError("BOOKING_POLICY_INVALID", "A percentage advance needs percentBps.", 422);
    }
    paise = Math.max(mulDivHalfUpPaise(estimatedTotalPaise, advance.percentBps, 10_000), advance.minPaise ?? 0);
  } else if (advance.mode === EcommerceBookingAdvanceMode.FIXED) {
    if (!Number.isInteger(advance.fixedPaise) || advance.fixedPaise < 1) {
      throw new AppError("BOOKING_POLICY_INVALID", "A fixed advance needs fixedPaise.", 422);
    }
    paise = advance.fixedPaise;
  } else {
    throw new AppError("BOOKING_POLICY_INVALID", "The booking policy has no advance rule.", 422);
  }
  return Math.max(1, Math.min(paise, estimatedTotalPaise));
}

export function advanceDueAt(policy, at) {
  return new Date(new Date(at).getTime() + Math.max(1, policy.advanceWindowMinutes ?? 30) * MINUTE);
}

/** Deadlines that start when the advance is captured. */
export function confirmedDeadlines(policy, capturedAt) {
  const base = new Date(capturedAt).getTime();
  return {
    balanceDueAt: new Date(base + Math.max(1, policy.balanceWindowHours ?? 72) * HOUR),
    rateProtectedUntil: new Date(base + Math.max(0, policy.rateProtectionHours ?? 0) * HOUR),
  };
}

/** Customer cancellation keeps `cancellationFeeBps` of the captured advance; the rest is refunded. */
export function cancellationRefundPaise({ advanceCapturedPaise, cancellationFeeBps = 0, waiveFee = false }) {
  if (!advanceCapturedPaise) return { refundPaise: 0, feePaise: 0 };
  const feePaise = waiveFee ? 0 : mulDivHalfUpPaise(advanceCapturedPaise, cancellationFeeBps, 10_000);
  return { refundPaise: advanceCapturedPaise - feePaise, feePaise };
}

/**
 * Which gold rate the final invoice uses.
 *
 *  BOOKED_RATE                       the booked rate while protection lasts, otherwise a fresh rate
 *  BILLING_DAY                       always a fresh rate
 *  LOWER_OF_BOOKED_AND_BILLING_DAY   a fresh rate is always required; the booked rate is used only
 *                                    while protection lasts and only when it is not higher
 *
 * `needsFreshRate` tells the caller to price against the live rate row (whose own freshness check
 * then applies). `savedRate` is only ever built here, from the booking's stored rate.
 */
export function chooseBillingRate({ rateRule, bookedRate, liveRatePerGramPaise = null, at = new Date() }) {
  const atMs = new Date(at).getTime();
  const protectedUntilMs = bookedRate?.protectedUntil ? new Date(bookedRate.protectedUntil).getTime() : 0;
  const protectedActive = Boolean(bookedRate?.ratePerGramPaise) && atMs < protectedUntilMs;
  const saved = () => buildSavedRateOption({
    ratePerGramPaise: bookedRate.ratePerGramPaise,
    purity: bookedRate.purity,
    rateId: bookedRate.rateId ?? null,
    rateVersion: bookedRate.rateVersion ?? null,
    savedAt: bookedRate.savedAt ?? null,
    validUntil: new Date(protectedUntilMs),
    at: new Date(atMs),
  });

  switch (rateRule) {
    case EcommerceBookingRateRule.BOOKED_RATE:
      return protectedActive
        ? { source: "BOOKED", needsFreshRate: false, savedRate: saved() }
        : { source: "BILLING_DAY", needsFreshRate: true, savedRate: null };
    case EcommerceBookingRateRule.BILLING_DAY:
      return { source: "BILLING_DAY", needsFreshRate: true, savedRate: null };
    case EcommerceBookingRateRule.LOWER_OF_BOOKED_AND_BILLING_DAY:
      if (protectedActive && Number.isInteger(liveRatePerGramPaise) && bookedRate.ratePerGramPaise <= liveRatePerGramPaise) {
        return { source: "BOOKED", needsFreshRate: true, savedRate: saved() };
      }
      return { source: "BILLING_DAY", needsFreshRate: true, savedRate: null };
    default:
      throw new AppError("BOOKING_POLICY_INVALID", "The booking policy has no gold-rate rule.", 422);
  }
}

/**
 * True when the rate protection a policy promises ends before the balance is due, so a final bill
 * generated late in the balance window falls back to the billing-day rate (BOOKED_RATE) or loses
 * the booked-rate option (LOWER_OF_...). BILLING_DAY policies promise no protection.
 */
export function bookingRateProtectionEndsEarly(policy) {
  if (policy?.rateRule === EcommerceBookingRateRule.BILLING_DAY) return false;
  return Math.max(0, policy?.rateProtectionHours ?? 0) < Math.max(1, policy?.balanceWindowHours ?? 72);
}
