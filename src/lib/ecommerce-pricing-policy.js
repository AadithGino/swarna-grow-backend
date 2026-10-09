/** Maximum age of a published ecommerce gold rate used for displayed pricing (7 days). */
export const ECOMMERCE_GOLD_RATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const ECOMMERCE_TAX_ESTIMATE_DISCLAIMER =
  "Display estimates use one configured rate per product classification. Checkout and invoices require jeweller accountant approval for component tax and CGST/SGST/IGST treatment.";

export const ECOMMERCE_FIXED_PRICE_NOTE =
  "Fixed base or sale price is all-inclusive (gold, making, stones, and other charges). Making and stone lines are not added again.";

export const ECOMMERCE_OFFER_POLICY_NOTE =
  "V1 offers apply only to the making charge on gold-rate-based products. They do not reduce total gold value or turn a dynamic product into a fixed total price.";

export function goldRateFreshness(rateRow, atMs = Date.now(), maxAgeMs = ECOMMERCE_GOLD_RATE_MAX_AGE_MS) {
  if (!rateRow?.effectiveAt) {
    return { fresh: false, code: "GOLD_RATE_MISSING", ageMs: null, maxAgeMs };
  }
  const effectiveMs = new Date(rateRow.effectiveAt).getTime();
  if (Number.isNaN(effectiveMs)) {
    return { fresh: false, code: "GOLD_RATE_INVALID", ageMs: null, maxAgeMs };
  }
  const ageMs = Math.max(0, atMs - effectiveMs);
  if (ageMs > maxAgeMs) {
    return { fresh: false, code: "GOLD_RATE_STALE", ageMs, maxAgeMs };
  }
  return { fresh: true, code: null, ageMs, maxAgeMs };
}
