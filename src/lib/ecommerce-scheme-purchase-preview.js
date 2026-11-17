import { errors } from "./app-error.js";
import { computeComponentTaxPaise } from "./ecommerce-checkout-tax.js";

const proportional = (amount, part, whole) => Number(BigInt(amount) * BigInt(part) / BigInt(whole));

export function previewSchemePurchase({ quote, eligibleProductIds, rules, basis, balance }) {
  const weight = basis === "GOLD_WEIGHT";
  const waiver = rules.makingChargeWaiver;
  let remaining = balance;
  let remainingWaiver = Math.min(rules.waiverCapPaise ?? Number.MAX_SAFE_INTEGER,
    waiver?.kind === "FIXED" ? waiver.amountPaise : Number.MAX_SAFE_INTEGER);
  let totalPaise = quote.fulfilmentChargePaise ?? 0;
  let appliedPaise = 0;
  let makingChargeWaivedPaise = 0;
  const lines = quote.lines.map((line) => {
    const estimate = line.pricingSnapshot?.estimate;
    const gold = estimate?.gold;
    const eligible = eligibleProductIds.has(line.productId) &&
      (!weight || (gold?.purity === "22K" && gold.weightMg > 0 && gold.goldValuePaise > 0));
    const makingPaise = (estimate?.making?.afterOfferPaise ?? 0) * line.quantity;
    const configuredWaiver = eligible && remaining > 0 && waiver
      ? (waiver.kind === "PERCENT" ? proportional(makingPaise, waiver.basisPoints, 10_000) : makingPaise) : 0;
    const maximumWaiver = Math.min(remainingWaiver, configuredWaiver);
    const taxFor = (subtotal) => computeComponentTaxPaise(subtotal, quote.financialSnapshot.taxComponentLines).totalPaise;
    const originalGross = line.lineTotalPaise + line.pricingSnapshot.componentTax.totalPaise;
    const fullWaiverSubtotal = line.lineTotalPaise - maximumWaiver;
    const coveredInFull = weight ? eligible && remaining >= gold.weightMg * line.quantity
      : remaining >= fullWaiverSubtotal + (maximumWaiver ? taxFor(fullWaiverSubtotal) : line.pricingSnapshot.componentTax.totalPaise);
    const coverageBase = weight && eligible ? gold.weightMg * line.quantity : originalGross;
    const lineWaiver = coveredInFull || !coverageBase ? maximumWaiver
      : Math.min(remainingWaiver, proportional(configuredWaiver, Math.min(remaining, coverageBase), coverageBase));
    remainingWaiver -= lineWaiver;
    makingChargeWaivedPaise += lineWaiver;
    const netPaise = line.lineTotalPaise - lineWaiver;
    const taxPaise = lineWaiver
      ? computeComponentTaxPaise(netPaise, quote.financialSnapshot.taxComponentLines).totalPaise
      : line.pricingSnapshot.componentTax.totalPaise;
    const grossPaise = netPaise + taxPaise;
    totalPaise += grossPaise;
    const unitsApplied = eligible ? Math.min(remaining, weight ? gold.weightMg * line.quantity : grossPaise) : 0;
    const lineAppliedPaise = weight && unitsApplied
      ? proportional(gold.goldValuePaise * line.quantity, unitsApplied, gold.weightMg * line.quantity)
      : unitsApplied;
    appliedPaise += lineAppliedPaise;
    remaining -= unitsApplied;
    return {
      productId: line.productId, quantity: line.quantity, eligible,
      makingChargeWaivedPaise: lineWaiver, subtotalPaise: netPaise, taxPaise,
      cashPaise: grossPaise - lineAppliedPaise, schemeAppliedPaise: lineAppliedPaise,
      ...(weight ? { schemeAppliedWeightMg: unitsApplied } : {}),
    };
  });
  if (!appliedPaise) throw errors.business("NO_SCHEME_AMOUNT_APPLICABLE", "No eligible item can use this scheme with the selected settlement basis.");
  return { basis, balance, remaining, applied: balance - remaining, appliedPaise,
    makingChargeWaivedPaise, totalPaise, topUpPaise: totalPaise - appliedPaise, lines };
}
