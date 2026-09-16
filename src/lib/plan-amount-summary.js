import { PaymentPattern } from "../constants/enums.js";
import { moneyRef } from "./money.js";

/** Customer- and admin-facing contribution summary for a scheme plan. */
export function buildAmountSummary(plan) {
  const rules = plan.amountRules ?? {};
  const mode = rules.amountMode;
  const minPaise = rules.minInstallmentPaise;
  const maxPaise = rules.maxInstallmentPaise;
  const multiplePaise = rules.multipleOfPaise;
  let label = "—";
  if (plan.paymentPattern === PaymentPattern.FLEXIBLE) {
    const flex = plan.flexibleRules ?? {};
    const free = flex.flexiblePhaseCycles ?? 6;
    const capped = flex.cappedPhaseCycles ?? 5;
    const div = flex.averagingDivisor ?? free;
    label = `Free phase ${free} cycles · capped phase ${capped} cycles (avg ÷ ${div}).`;
    const flexPhase = flex.flexiblePhase ?? {};
    if (flexPhase.minimumPaymentPaise != null && flexPhase.maximumPaymentPaise != null) {
      label += ` Pay ${moneyRef(flexPhase.minimumPaymentPaise).amountDisplay} – ${moneyRef(flexPhase.maximumPaymentPaise).amountDisplay} per payment in the free window.`;
    }
  } else if (mode === "CUSTOMER_CHOSEN" && minPaise != null && maxPaise != null) {
    label = `Customers can choose ${moneyRef(minPaise).amountDisplay} – ${moneyRef(maxPaise).amountDisplay}, in multiples of ${moneyRef(multiplePaise ?? 100).amountDisplay}.`;
  } else if (mode === "JEWELLER_FIXED" && rules.fixedAmountPaise != null) {
    label = `Fixed ${moneyRef(rules.fixedAmountPaise).amountDisplay} per installment.`;
  } else if (mode === "JEWELLER_SLABS" && rules.slabsPaise?.length) {
    const slabs = rules.slabsPaise.map((p) => moneyRef(p).amountDisplay).join(" · ");
    label = `Slabs ${slabs} per installment.`;
  }
  return {
    amountMode: mode,
    min: minPaise != null ? moneyRef(minPaise) : null,
    max: maxPaise != null ? moneyRef(maxPaise) : null,
    multipleOf: multiplePaise != null ? moneyRef(multiplePaise) : null,
    label,
  };
}

export function planBenefitLabel(plan) {
  const benefit = plan?.benefit;
  if (!benefit?.type) return "";
  if (benefit.displayLabel) return benefit.displayLabel;
  if (benefit.type === "FIXED_BONUS_AMOUNT") {
    if (benefit.bonusValue != null && benefit.bonusBasis === "PERCENT_OF_PAID") {
      return `${benefit.bonusValue}% bonus on maturity`;
    }
    return "Fixed bonus at maturity";
  }
  if (benefit.type === "ONE_FREE_INSTALLMENT") return "One free instalment on completion";
  if (benefit.type === "CASH_BONUS") return "Cash bonus based on completed cycles";
  if (benefit.type === "GOLD_BENEFIT") return "Gold benefit valued at maturity rate";
  return benefit.displayName ?? benefit.type;
}
