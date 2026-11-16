import Decimal from "decimal.js";
import { decimalRoundingMode, percentOfPaiseFloor } from "./money.js";
import { BenefitType, SchemeStatus } from "../constants/enums.js";

/** Financial rules on new plan versions and on frozen Aira snapshots. */
export function maturityGoldRules(plan) {
  if (plan?.benefit?.type === BenefitType.MATURITY_GOLD_CREDIT) return plan.benefit.goldBonus;
  const legacy = plan?.collectionRules;
  if (!legacy?.bonusPercent || !legacy.bonusBasis) return undefined;
  const { bonusPercent, bonusBasis, requireAllCollections } = legacy;
  return { bonusPercent, bonusBasis, requireAllCollections };
}

export function maturityGoldLabel(rules) {
  return `${rules.bonusPercent}% additional gold at maturity`;
}

export const UNAWARDED_TERMINAL_GOLD_BONUS_STATUSES = [
  SchemeStatus.REDEEMED,
  SchemeStatus.CLOSED_PREMATURE,
  SchemeStatus.ENROLMENT_EXPIRED,
];

export function isMaturityGoldResolved(bonus) {
  if (bonus?.status === "CREDITED") return bonus.weightMg > 0 && Boolean(bonus.ledgerEntryId);
  return bonus?.status === "INELIGIBLE" && bonus.weightMg === 0;
}

export function maturityGoldStatus(scheme, totals = scheme.totals) {
  const rules = maturityGoldRules(scheme.planSnapshot);
  if (!rules) return undefined;
  if (UNAWARDED_TERMINAL_GOLD_BONUS_STATUSES.includes(scheme.status) && !isMaturityGoldResolved(scheme.collectionBonus)) {
    return { status: "INELIGIBLE", weightMg: 0 };
  }
  if (scheme.collectionBonus) return scheme.collectionBonus;
  const estimatedWeightMg = rules.bonusBasis === "NET_GOLD_WEIGHT" && totals?.goldWeightMg > 0
    ? collectionBonusWeight(rules, totals, scheme.planSnapshot.goldRules)
    : 0;
  return { status: "PENDING", weightMg: 0, ...(estimatedWeightMg > 0 ? { estimatedWeightMg } : {}) };
}

export function collectionBonusWeight(rules, totals, goldRules, ratePerGramPaise) {
  const rounding = decimalRoundingMode(goldRules?.weightRoundingMode ?? "HALF_UP");
  const precision = goldRules?.weightPrecisionMg || 1;
  const weightMg = rules.bonusBasis === "NET_GOLD_WEIGHT"
    ? new Decimal(totals.goldWeightMg).mul(rules.bonusPercent).div(100)
    : new Decimal(percentOfPaiseFloor(totals.amountPaidPaise, rules.bonusPercent)).mul(1000).div(ratePerGramPaise);
  return weightMg.div(precision).toDecimalPlaces(0, rounding).mul(precision).toNumber();
}
