import { computeConfiguredBenefitPaise } from "./scheme-benefit.js";

function schemeTotals(scheme) {
  const raw = scheme.totals ?? {};
  return {
    amountPaidPaise: Math.max(
      0,
      Number(raw.amountPaidPaise ?? raw.totalPaid?.amountPaise ?? 0),
    ),
    goldWeightMg: Math.max(0, Number(raw.goldWeightMg ?? 0)),
  };
}

/** Admin maturity projection — net principal and configured benefit at maturity (not settlement preview). */
export function buildSchemeMaturityProjection(scheme) {
  const totals = schemeTotals(scheme);
  const benefitDef = scheme.planSnapshot?.benefit;
  const projectedBenefitPaise = computeConfiguredBenefitPaise(scheme, totals, benefitDef);
  const projectedPrincipalPaise = totals.amountPaidPaise;
  return {
    schemeId: scheme._id,
    maturityDate: scheme.maturityDate,
    projectedPrincipalPaise,
    projectedBenefitPaise,
    projectedAmountPaise: projectedPrincipalPaise + projectedBenefitPaise,
    projectedWeightMg: totals.goldWeightMg,
  };
}
