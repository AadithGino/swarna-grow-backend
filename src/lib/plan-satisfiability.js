import * as E from "../constants/enums.js";

/** True when YYYY-MM-DD is a real calendar date (rejects 2026-99-99, Feb 30, month 13). */
export function isValidCalendarDateString(value) {
  const str = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const year = Number(str.slice(0, 4));
  const month = Number(str.slice(5, 7));
  const day = Number(str.slice(8, 10));
  if (month < 1 || month > 12) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day
  );
}

/** Some step-aligned amount exists in [minPaise, maxPaise] (inclusive). */
export function rangeAdmitsStepAlignedAmount(minPaise, maxPaise, stepPaise) {
  if (minPaise == null || maxPaise == null || minPaise > maxPaise) return false;
  const step = stepPaise != null && stepPaise > 0 ? stepPaise : 1;
  const first = Math.ceil(minPaise / step) * step;
  return first <= maxPaise;
}

function addSatisfiabilityIssue(context, path, message) {
  context.addIssue({ code: "custom", path, message });
}

/**
 * Reject plan configurations where no valid customer payment amount can exist.
 * Called from {@link refinePlanCrossFields} after structural cross-field checks.
 */
export function refinePlanSatisfiability(value, context) {
  const amountRules = value.amountRules ?? {};
  const paymentRules = value.paymentRules ?? {};
  const maxTxn = paymentRules.maxPaymentPerTransactionPaise ?? null;

  if (
    amountRules.amountMode === E.AmountMode.CUSTOMER_CHOSEN
    && amountRules.minInstallmentPaise != null
    && amountRules.maxInstallmentPaise != null
  ) {
    if (
      !rangeAdmitsStepAlignedAmount(
        amountRules.minInstallmentPaise,
        amountRules.maxInstallmentPaise,
        amountRules.multipleOfPaise,
      )
    ) {
      addSatisfiabilityIssue(context, ["amountRules", "multipleOfPaise"], "No installment amount in the chosen range satisfies multipleOfPaise.");
    }
  }

  if (
    paymentRules.partialPaymentAllowed === false
    && amountRules.amountMode === E.AmountMode.JEWELLER_FIXED
    && amountRules.fixedAmountPaise != null
    && maxTxn != null
    && amountRules.fixedAmountPaise > maxTxn
  ) {
    addSatisfiabilityIssue(
      context,
      ["paymentRules", "maxPaymentPerTransactionPaise"],
      "Fixed installment exceeds max payment per transaction while partial payments are disabled.",
    );
  }

  const flex = value.flexibleRules;
  if (flex?.flexiblePhase) {
    const fp = flex.flexiblePhase;
    if (
      !rangeAdmitsStepAlignedAmount(
        fp.minimumPaymentPaise,
        fp.maximumPaymentPaise,
        fp.paymentIncrementPaise,
      )
    ) {
      addSatisfiabilityIssue(
        context,
        ["flexibleRules", "flexiblePhase", "paymentIncrementPaise"],
        "No flexible-phase payment amount satisfies paymentIncrementPaise within the min/max range.",
      );
    }
  }
  if (flex?.cappedPhase && flex?.capComputation) {
    if (flex.cappedPhase.minimumPaymentPaise > flex.capComputation.maxCycleCapPaise) {
      addSatisfiabilityIssue(
        context,
        ["flexibleRules", "cappedPhase", "minimumPaymentPaise"],
        "Capped-phase minimum payment exceeds the maximum possible cycle cap.",
      );
    }
  }

  const eligibility = value.benefit?.eligibility;
  if (eligibility && value.durationMonths != null) {
    if (eligibility.minMonthsCompleted > value.durationMonths) {
      addSatisfiabilityIssue(
        context,
        ["benefit", "eligibility", "minMonthsCompleted"],
        "minMonthsCompleted cannot exceed durationMonths.",
      );
    }
  }
  if (eligibility && value.installmentCount != null) {
    if (eligibility.maxAllowedDefaults > value.installmentCount) {
      addSatisfiabilityIssue(
        context,
        ["benefit", "eligibility", "maxAllowedDefaults"],
        "maxAllowedDefaults cannot exceed installmentCount.",
      );
    }
  }

  if (amountRules.amountMode === E.AmountMode.JEWELLER_SLABS) {
    const slabs = amountRules.slabsPaise ?? [];
    const seen = new Set();
    for (let i = 0; i < slabs.length; i += 1) {
      const slab = slabs[i];
      if (seen.has(slab)) {
        addSatisfiabilityIssue(context, ["amountRules", "slabsPaise"], "Slab amounts must be unique.");
        break;
      }
      seen.add(slab);
      if (maxTxn != null && slab > maxTxn) {
        addSatisfiabilityIssue(
          context,
          ["amountRules", "slabsPaise"],
          "Each slab amount must not exceed max payment per transaction.",
        );
        break;
      }
    }
  }
}

export function refineCalendarDateField(context, path, rawValue) {
  if (rawValue == null || rawValue === "") return;
  const str = String(rawValue);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    addSatisfiabilityIssue(context, path, `${path.at(-1)} must be YYYY-MM-DD.`);
    return;
  }
  if (!isValidCalendarDateString(str)) {
    addSatisfiabilityIssue(context, path, `${path.at(-1)} is not a valid calendar date.`);
  }
}
