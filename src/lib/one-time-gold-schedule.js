import Decimal from "decimal.js";
import { addMonthsClamped } from "./date.js";
import { decimalRoundingMode } from "./money.js";

export function buildOneTimeGoldSchedule(plan, fundedOn) {
  const count = plan.oneTimeRules.timing === "MONTHLY" ? plan.durationMonths : 1;
  return Array.from({ length: count }, (_, index) => ({
    period: index + 1,
    dueDate: addMonthsClamped(fundedOn, count === 1 ? plan.durationMonths : index + 1).format("YYYY-MM-DD"),
    status: "PENDING",
    weightMg: 0,
  }));
}

export function oneTimeCreditWeight({ rules, period, count, principal, originalPaidPaise, rate, goldRules }) {
  if (!(principal.amountPaidPaise > 0 && principal.goldWeightMg > 0)) return 0;
  const basis = rules.basis === "PRINCIPAL_PERCENT"
    ? new Decimal(principal.goldWeightMg).mul(rules.value).div(100)
    : new Decimal(rules.value).mul(principal.amountPaidPaise).div(originalPaidPaise);
  const precision = goldRules?.weightPrecisionMg || 1;
  const round = decimalRoundingMode(goldRules?.weightRoundingMode);
  if (rules.basis === "RUPEE_PAISE") {
    const paise = rules.amountPeriod === "TERM_TOTAL"
      ? basis.mul(period).div(count).floor().minus(basis.mul(period - 1).div(count).floor())
      : basis.floor();
    return paise.mul(1000).div(rate).div(precision).toDecimalPlaces(0, round).mul(precision).toNumber();
  }
  const rounded = basis.div(precision).toDecimalPlaces(0, round);
  const units = rules.amountPeriod === "TERM_TOTAL"
    ? rounded.mul(period).div(count).floor().minus(rounded.mul(period - 1).div(count).floor())
    : rounded;
  return units.mul(precision).toNumber();
}

export function oneTimeGoldProgress(scheme) {
  const rules = scheme.planSnapshot?.oneTimeRules;
  if (!rules) return undefined;
  const state = scheme.oneTimeGold;
  const periods = state?.periods ?? [];
  const terminal = ["REDEEMED", "CLOSED_PREMATURE", "ENROLMENT_EXPIRED"].includes(scheme.status);
  const creditedWeightMg = periods.reduce((sum, row) => sum + (row.weightMg ?? 0), 0);
  return {
    rules, fundedOn: state?.fundedOn, maturityDate: state ? scheme.maturityDate : undefined,
    principalWeightMg: scheme.totals?.goldWeightMg ?? state?.principalWeightMg ?? 0,
    fundingRatePerGramPaise: state?.fundingRatePerGramPaise,
    originalPaidPaise: state?.originalPaidPaise ?? 0,
    creditedWeightMg, redeemableBonusWeightMg: scheme.status === "MATURED" ? creditedWeightMg : 0,
    nextCreditDate: terminal ? undefined : state?.nextCreditDate,
    periods: periods.map(({ period, dueDate, status, weightMg, ratePerGramPaise }) => ({
      period, dueDate, status: terminal && ["PENDING", "PENDING_RATE"].includes(status) ? "CANCELLED" : status,
      weightMg, ratePerGramPaise,
    })),
  };
}
