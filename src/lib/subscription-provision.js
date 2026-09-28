import { AppError } from "./app-error.js";
import { BillingCycle, PlanTier } from "../constants/enums.js";
import { limitsFromApi } from "../constants/plan-features.js";
import { planFeaturesSnapshotFromPlan } from "./feature-entitlements.js";

const BILLING_CYCLES = Object.values(BillingCycle);

export function normalizeSupportedBillingCycles(planOrBody, fallbackCycle = BillingCycle.MONTHLY) {
  const raw = planOrBody?.supportedBillingCycles;
  if (Array.isArray(raw) && raw.length > 0) {
    const unique = [...new Set(raw.filter((c) => BILLING_CYCLES.includes(c)))];
    if (unique.length > 0) return unique;
  }
  const legacy = planOrBody?.billingCycle ?? fallbackCycle;
  return legacy === BillingCycle.ANNUAL ? [BillingCycle.ANNUAL] : [BillingCycle.MONTHLY, BillingCycle.ANNUAL];
}

export function assertPlanAllowsBillingCycle(plan, billingCycle) {
  const allowed = normalizeSupportedBillingCycles(plan, plan?.billingCycle);
  if (!billingCycle || !allowed.includes(billingCycle)) {
    throw new AppError(
      "BILLING_CYCLE_NOT_SUPPORTED",
      `Billing cycle ${billingCycle ?? "(missing)"} is not supported for this plan.`,
      422,
      { allowed, billingCycle },
    );
  }
}

/** Persisted subscription fields shared by signup, platform create, and plan change. */
export function subscriptionPatchFromPlan(plan, { billingCycle, trialEndsAt, status, existingSubscription = {} } = {}) {
  const tier = plan?.tier ?? existingSubscription.tier ?? PlanTier.STARTER;
  const cycle = billingCycle ?? existingSubscription.billingCycle ?? BillingCycle.MONTHLY;
  if (plan) assertPlanAllowsBillingCycle(plan, cycle);
  const snapshot = planFeaturesSnapshotFromPlan(plan ?? { tier });
  return {
    tier,
    billingCycle: cycle,
    planId: plan?._id ?? existingSubscription.planId,
    limits: limitsFromApi(plan?.limits ?? existingSubscription.limits ?? {}),
    planFeaturesSnapshot: snapshot,
    features: Object.entries(snapshot).filter(([, on]) => on).map(([key]) => key),
    ...(trialEndsAt != null ? { trialEndsAt } : {}),
    ...(status != null ? { status } : {}),
  };
}

export function planPriceForBillingCycle(plan, billingCycle) {
  if (!plan) return 0;
  if (billingCycle === BillingCycle.ANNUAL) {
    return plan.yearlyPricePaise ?? (plan.monthlyPricePaise ?? plan.pricePaise ?? 0) * 12;
  }
  return plan.monthlyPricePaise ?? plan.pricePaise ?? 0;
}
