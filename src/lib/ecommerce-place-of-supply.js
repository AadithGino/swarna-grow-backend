import { EcommerceFulfilmentMode, EcommerceTaxSupplyCase } from "../constants/enums.js";

export function normalizeIndianStateName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function resolveDestinationState({ fulfilmentMode, addressSnapshot, checkoutTaxConfig }) {
  if (fulfilmentMode === EcommerceFulfilmentMode.DELIVERY) {
    return String(addressSnapshot?.state ?? "").trim();
  }
  return String(checkoutTaxConfig?.defaultPlaceOfSupplyState ?? checkoutTaxConfig?.registeredState ?? "").trim();
}

export function resolveSupplyCase(registeredState, destinationState) {
  const reg = normalizeIndianStateName(registeredState);
  const dest = normalizeIndianStateName(destinationState);
  if (!reg || !dest) return null;
  return reg === dest ? EcommerceTaxSupplyCase.INTRA_STATE : EcommerceTaxSupplyCase.INTER_STATE;
}

export function pickComponentLinesForSupplyCase(checkoutTaxConfig, supplyCase) {
  const rules = Array.isArray(checkoutTaxConfig?.componentRules)
    ? checkoutTaxConfig.componentRules
    : [];
  const match = rules.find((r) => r.supplyCase === supplyCase);
  if (match?.componentLines?.length) return match.componentLines;
  if (supplyCase === EcommerceTaxSupplyCase.INTRA_STATE && checkoutTaxConfig?.componentLines?.length) {
    return checkoutTaxConfig.componentLines;
  }
  return [];
}

export function isDestinationStateSupported(checkoutTaxConfig, destinationState) {
  const dest = normalizeIndianStateName(destinationState);
  if (!dest) return false;
  const supported = checkoutTaxConfig?.supportedDestinationStates ?? [];
  if (!supported.length) {
    const defaults = [
      checkoutTaxConfig?.registeredState,
      checkoutTaxConfig?.defaultPlaceOfSupplyState,
    ]
      .map(normalizeIndianStateName)
      .filter(Boolean);
    return defaults.includes(dest);
  }
  return supported.some((s) => normalizeIndianStateName(s) === dest);
}
