import { PaymentPattern } from "../constants/enums.js";

export function computeConfiguredBenefitPaise(scheme, totals, benefitDef) {
  if (!benefitDef || benefitDef.type === "TEXT_ONLY") return 0;
  let benefitPaise = 0;
  if (benefitDef.type === "FIXED_BONUS_AMOUNT") {
    benefitPaise =
      benefitDef.bonusBasis === "PERCENT_OF_PAID"
        ? Math.floor((totals.amountPaidPaise * benefitDef.bonusValue) / 100)
        : benefitDef.bonusValue;
    if (benefitDef.maxBonusPaise) benefitPaise = Math.min(benefitPaise, benefitDef.maxBonusPaise);
  }
  if (benefitDef.type === "ONE_FREE_INSTALLMENT") {
    if (scheme.paymentPattern === PaymentPattern.FLEXIBLE) return 0;
    benefitPaise = scheme.installmentAmountPaise ?? 0;
  }
  return Math.max(0, benefitPaise);
}

/** Benefit for closure/redemption; FORFEIT and system-policy closure yield zero. FULL is never treated as FORFEIT. */
export function computeClosureBenefitPaise({
  scheme,
  totals,
  benefitDef,
  benefitEligible,
  isPremature,
  prematureBenefitTreatment,
  systemPolicyClosure,
}) {
  if (systemPolicyClosure) return 0;
  if (isPremature && prematureBenefitTreatment === "FORFEIT") return 0;
  const includeBenefit =
    benefitEligible || (isPremature && prematureBenefitTreatment === "FULL");
  if (!includeBenefit) return 0;
  return computeConfiguredBenefitPaise(scheme, totals, benefitDef);
}
