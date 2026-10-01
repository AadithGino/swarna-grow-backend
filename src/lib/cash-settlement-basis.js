import {
  BenefitType,
  CashSettlementBasis,
  PaidAmountBenefitTreatment,
  RedemptionMode,
  ValueBasis,
} from "../constants/enums.js";

const DEFAULT_CASH_SETTLEMENT_BASIS = CashSettlementBasis.GOLD_VALUE;
const DEFAULT_PAID_AMOUNT_BENEFIT_TREATMENT = PaidAmountBenefitTreatment.EXCLUDE;

export function resolveCashSettlementBasisFromRedemptionRules(rules) {
  const raw = rules?.cashSettlementBasis;
  if (raw == null || raw === "") return DEFAULT_CASH_SETTLEMENT_BASIS;
  return raw;
}

export function resolvePaidAmountBenefitTreatmentFromRedemptionRules(rules) {
  const raw = rules?.paidAmountBenefitTreatment;
  if (raw == null || raw === "") return DEFAULT_PAID_AMOUNT_BENEFIT_TREATMENT;
  return raw;
}

export function resolveCashSettlementRulesFromScheme(scheme) {
  const rules = scheme?.planSnapshot?.redemptionRules ?? {};
  return {
    cashSettlementBasis: resolveCashSettlementBasisFromRedemptionRules(rules),
    paidAmountBenefitTreatment:
      resolvePaidAmountBenefitTreatmentFromRedemptionRules(rules),
  };
}

/** PAID_AMOUNT applies only to gold-weight schemes settling in CASH. */
export function usesPaidAmountCashSettlement({
  valueBasis,
  mode,
  cashSettlementBasis,
}) {
  return (
    valueBasis === ValueBasis.GOLD_WEIGHT
    && mode === RedemptionMode.CASH
    && cashSettlementBasis === CashSettlementBasis.PAID_AMOUNT
  );
}

const MONETARY_BENEFIT_TYPES = new Set([
  BenefitType.FIXED_BONUS_AMOUNT,
  BenefitType.ONE_FREE_INSTALLMENT,
]);

export function paidAmountIncludeMonetaryBenefitAllowed(benefitDef) {
  if (!benefitDef || benefitDef.type === BenefitType.TEXT_ONLY) return false;
  return MONETARY_BENEFIT_TYPES.has(benefitDef.type);
}

/**
 * Block settlement when INCLUDE_MONETARY cannot be expressed in paise without a gold-rate conversion.
 */
export function paidAmountMonetaryBenefitBlocker(benefitDef, paidAmountBenefitTreatment) {
  if (paidAmountBenefitTreatment !== PaidAmountBenefitTreatment.INCLUDE_MONETARY) {
    return null;
  }
  if (!benefitDef || benefitDef.type === BenefitType.TEXT_ONLY) {
    return {
      code: "CASH_SETTLEMENT_BENEFIT_NOT_MONETARY",
      message:
        "Paid-amount cash settlement cannot include a non-monetary benefit. Change benefit treatment or plan benefit.",
    };
  }
  if (!MONETARY_BENEFIT_TYPES.has(benefitDef.type)) {
    return {
      code: "CASH_SETTLEMENT_BENEFIT_NOT_MONETARY",
      message:
        "Paid-amount cash settlement can only include benefits computed in rupees (fixed bonus or one free installment).",
    };
  }
  return null;
}

export function refinePlanCashSettlementRules(value, context) {
  const redemption = value.redemptionRules ?? {};
  const hasCashBasisField = redemption.cashSettlementBasis != null;
  const hasBenefitTreatmentField = redemption.paidAmountBenefitTreatment != null;
  const allowedModes = redemption.allowedModes ?? [];
  const cashAllowed = allowedModes.includes(RedemptionMode.CASH);
  const isGoldWeight = value.valueBasis === ValueBasis.GOLD_WEIGHT;

  if (!isGoldWeight || !cashAllowed) {
    if (hasCashBasisField) {
      context.addIssue({
        code: "custom",
        path: ["redemptionRules", "cashSettlementBasis"],
        message:
          "cashSettlementBasis applies only to gold-weight plans that allow CASH redemption.",
      });
    }
    if (hasBenefitTreatmentField) {
      context.addIssue({
        code: "custom",
        path: ["redemptionRules", "paidAmountBenefitTreatment"],
        message:
          "paidAmountBenefitTreatment applies only to gold-weight plans that allow CASH redemption.",
      });
    }
    return;
  }

  const basis =
    redemption.cashSettlementBasis ?? DEFAULT_CASH_SETTLEMENT_BASIS;
  if (
    redemption.cashSettlementBasis != null
    && !Object.values(CashSettlementBasis).includes(redemption.cashSettlementBasis)
  ) {
    context.addIssue({
      code: "custom",
      path: ["redemptionRules", "cashSettlementBasis"],
      message: "cashSettlementBasis must be GOLD_VALUE or PAID_AMOUNT.",
    });
    return;
  }

  const treatment =
    redemption.paidAmountBenefitTreatment ?? DEFAULT_PAID_AMOUNT_BENEFIT_TREATMENT;
  if (
    redemption.paidAmountBenefitTreatment != null
    && !Object.values(PaidAmountBenefitTreatment).includes(
      redemption.paidAmountBenefitTreatment,
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["redemptionRules", "paidAmountBenefitTreatment"],
      message: "paidAmountBenefitTreatment must be EXCLUDE or INCLUDE_MONETARY.",
    });
    return;
  }

  if (basis === CashSettlementBasis.GOLD_VALUE && hasBenefitTreatmentField) {
    context.addIssue({
      code: "custom",
      path: ["redemptionRules", "paidAmountBenefitTreatment"],
      message:
        "paidAmountBenefitTreatment is only used when cashSettlementBasis is PAID_AMOUNT.",
    });
  }

  if (basis === CashSettlementBasis.PAID_AMOUNT) {
    if (
      treatment === PaidAmountBenefitTreatment.INCLUDE_MONETARY
      && !paidAmountIncludeMonetaryBenefitAllowed(value.benefit)
    ) {
      context.addIssue({
        code: "custom",
        path: ["redemptionRules", "paidAmountBenefitTreatment"],
        message:
          "INCLUDE_MONETARY requires a monetary plan benefit (fixed bonus or one free installment).",
      });
    }
  }
}

export {
  DEFAULT_CASH_SETTLEMENT_BASIS,
  DEFAULT_PAID_AMOUNT_BENEFIT_TREATMENT,
};
