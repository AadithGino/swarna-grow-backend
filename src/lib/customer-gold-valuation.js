import { moneyPaiseFromWeightMg, moneyRef } from "./money.js";

/**
 * Customer portfolio valuation for gold-weight schemes.
 * Never substitutes total cash paid when the 22K rate is missing.
 */
export function buildCustomerGoldValuation({
  hasGoldAccumulationScheme,
  netGoldWeightMg,
  ratePerGramPaise,
}) {
  if (!hasGoldAccumulationScheme) {
    return {
      currentValuation: undefined,
      valuationAvailable: false,
      valuationBlocker: null,
    };
  }
  const weightMg = Math.max(0, Number(netGoldWeightMg ?? 0));
  if (!(ratePerGramPaise > 0)) {
    return {
      currentValuation: null,
      valuationAvailable: false,
      valuationBlocker: "GOLD_RATE_NOT_SET",
    };
  }
  return {
    currentValuation: moneyRef(moneyPaiseFromWeightMg(weightMg, ratePerGramPaise)),
    valuationAvailable: true,
    valuationBlocker: null,
  };
}
