/** Treat schema default 0 on optional paise fields as unset. */
export function paiseOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Align amount/payment rules for display and validation (fixes integerField default 0).
 * Mutates the passed plan-like object in place.
 */
export function normalizePlanFinancialRules(plan) {
  if (!plan || typeof plan !== "object") return plan;
  const rules = plan.amountRules ?? {};
  plan.amountRules = rules;
  const fixed = paiseOrNull(rules.fixedAmountPaise);
  if (rules.amountMode === "JEWELLER_FIXED" && fixed) {
    rules.fixedAmountPaise = fixed;
    rules.minInstallmentPaise = fixed;
    rules.maxInstallmentPaise = fixed;
    if (!paiseOrNull(rules.multipleOfPaise)) {
      delete rules.multipleOfPaise;
    }
  } else {
    const min = paiseOrNull(rules.minInstallmentPaise);
    const max = paiseOrNull(rules.maxInstallmentPaise);
    const mult = paiseOrNull(rules.multipleOfPaise);
    if (min != null) rules.minInstallmentPaise = min;
    else delete rules.minInstallmentPaise;
    if (max != null) rules.maxInstallmentPaise = max;
    else delete rules.maxInstallmentPaise;
    if (mult != null) rules.multipleOfPaise = mult;
    else delete rules.multipleOfPaise;
  }

  const payment = plan.paymentRules ?? {};
  plan.paymentRules = payment;
  const minPay = paiseOrNull(payment.minPaymentPaise);
  let maxPay = paiseOrNull(payment.maxPaymentPerTransactionPaise);
  if (!maxPay && rules.amountMode === "JEWELLER_FIXED" && fixed) {
    maxPay = fixed;
  }
  if (minPay != null) payment.minPaymentPaise = minPay;
  else delete payment.minPaymentPaise;
  if (maxPay != null) payment.maxPaymentPerTransactionPaise = maxPay;
  else delete payment.maxPaymentPerTransactionPaise;

  return plan;
}
