/**
 * Flexible plans: `durationMonths` is calendar tenure to maturity;
 * free + capped phases cover payment months (`installmentCount` when set).
 */
export function flexiblePhaseTargetMonths(planLike) {
  const duration = Number(planLike?.durationMonths);
  const installment = planLike?.installmentCount;
  if (installment != null && Number.isFinite(Number(installment))) {
    return Number(installment);
  }
  return duration;
}

export function flexiblePhaseCyclesValid(planLike) {
  const rules = planLike?.flexibleRules;
  if (!rules) return true;
  const flex = Number(rules.flexiblePhaseCycles ?? 0);
  const capped = Number(rules.cappedPhaseCycles ?? 0);
  return flex + capped === flexiblePhaseTargetMonths(planLike);
}

/** Calendar tenure months (includes maturity-only tail when installmentCount is lower). */
export function flexibleCalendarCycleCount(planLike) {
  const duration = Number(planLike?.durationMonths);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

/** Contribution / payment months (defaults to duration when installmentCount omitted). */
export function flexibleContributionCycleCount(planLike) {
  return flexiblePhaseTargetMonths(planLike);
}

/** Zero-based cycle index is maturity-only when beyond contribution months but within calendar tenure. */
export function isFlexibleMaturityOnlyCycleIndex(cycleIndex, planLike) {
  const calendar = flexibleCalendarCycleCount(planLike);
  const contribution = flexibleContributionCycleCount(planLike);
  if (!calendar || !contribution) return false;
  return calendar > contribution && cycleIndex >= contribution;
}
