import { AppError } from "./app-error.js";
import {
  EcommerceMakingChargeMode,
  EcommerceOfferType,
  EcommercePriceMode,
} from "../constants/enums.js";
import {
  ECOMMERCE_FIXED_PRICE_NOTE,
  ECOMMERCE_GOLD_RATE_MAX_AGE_MS,
  ECOMMERCE_OFFER_POLICY_NOTE,
  ECOMMERCE_TAX_ESTIMATE_DISCLAIMER,
  goldRateFreshness,
} from "./ecommerce-pricing-policy.js";
import { addPaise, mulDivHalfUpPaise } from "./ecommerce-exact-money.js";

/**
 * Pricing formula (integer paise, weight in mg):
 * 1. goldValuePaise = roundHalfUp(weightMg × ratePerGramPaise ÷ 1000)
 * 2. makingPaise from mode (fixed | per-gram | % of gold), then offer discount on making only
 * 3. stonesPaise = sum(stone lines) or stoneChargePaise
 * 4. otherPaise = otherChargesPaise
 * 5. preTaxSubtotal = gold + makingAfterOffer + stones + other (FIXED: all-inclusive base/sale only — no extra making/stones)
 * 6. tax lines = roundHalfUp(taxableBase × rateBps ÷ 10000) per configured rate
 * 7. displayTotalPaise = preTaxSubtotal + sum(taxes)
 */

export function roundHalfUpPaise(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value);
}

export function computeGoldValuePaise(weightMg, ratePerGramPaise) {
  if (weightMg <= 0 || ratePerGramPaise <= 0) return 0;
  return mulDivHalfUpPaise(weightMg, ratePerGramPaise, 1000);
}

export function computeMakingChargePaise({
  mode,
  goldValuePaise,
  weightMg,
  makingCharge = {},
}) {
  if (mode === EcommerceMakingChargeMode.FIXED_PAISE) {
    return Math.max(0, makingCharge.fixedPaise ?? 0);
  }
  if (mode === EcommerceMakingChargeMode.PER_GRAM_PAISE) {
    const perGram = Math.max(0, makingCharge.perGramPaise ?? 0);
    return mulDivHalfUpPaise(perGram, weightMg, 1000);
  }
  if (mode === EcommerceMakingChargeMode.PERCENT_OF_GOLD) {
    const bps = Math.max(0, makingCharge.percentBps ?? 0);
    return mulDivHalfUpPaise(goldValuePaise, bps, 10_000);
  }
  return 0;
}

export function applyMakingChargeOffer(makingPaise, offer, atMs = Date.now()) {
  if (!offer || makingPaise <= 0) {
    return { discountPaise: 0, makingAfterPaise: makingPaise };
  }
  if (offer.startsAt && new Date(offer.startsAt).getTime() > atMs) {
    return { discountPaise: 0, makingAfterPaise: makingPaise };
  }
  if (offer.endsAt && new Date(offer.endsAt).getTime() < atMs) {
    return { discountPaise: 0, makingAfterPaise: makingPaise };
  }
  if (offer.type === EcommerceOfferType.FIXED_PAISE_OFF) {
    const off = Math.max(0, offer.valuePaise ?? 0);
    if (off > makingPaise) {
      throw new AppError(
        "ECOMMERCE_OFFER_EXCEEDS_MAKING",
        "Offer discount cannot exceed the making charge.",
        422,
        { makingPaise, offerPaise: off },
      );
    }
    return { discountPaise: off, makingAfterPaise: makingPaise - off };
  }
  if (offer.type === EcommerceOfferType.PERCENT_OFF) {
    const bps = Math.min(10_000, Math.max(0, offer.percentBps ?? 0));
    const discount = mulDivHalfUpPaise(makingPaise, bps, 10_000);
    return { discountPaise: discount, makingAfterPaise: makingPaise - discount };
  }
  return { discountPaise: 0, makingAfterPaise: makingPaise };
}

function sumStoneCharges(product) {
  if (Array.isArray(product.stones) && product.stones.length) {
    return product.stones.reduce(
      (sum, row) => sum + Math.max(0, row.chargePaise ?? 0),
      0,
    );
  }
  return Math.max(0, product.stoneChargePaise ?? 0);
}

function activeFixedBasePaise(product, atMs) {
  const fixed = product.fixedPricing ?? {};
  const sale = fixed.salePricePaise;
  if (sale != null && sale >= 0) {
    const from = fixed.saleStartsAt ? new Date(fixed.saleStartsAt).getTime() : null;
    const to = fixed.saleEndsAt ? new Date(fixed.saleEndsAt).getTime() : null;
    if ((from == null || from <= atMs) && (to == null || to >= atMs)) {
      return sale;
    }
  }
  return Math.max(0, fixed.basePricePaise ?? 0);
}

function resolveTaxRate(taxSettings, classification) {
  const rates = taxSettings?.rates ?? [];
  const code = classification ?? taxSettings?.defaultClassification ?? null;
  if (!code) return null;
  return rates.find((row) => row.code === code && row.active !== false) ?? null;
}

export function computeProductPriceEstimate({
  product,
  rateRow = null,
  taxSettings = null,
  atMs = Date.now(),
  rateMaxAgeMs = ECOMMERCE_GOLD_RATE_MAX_AGE_MS,
}) {
  const blockers = [];
  const priceMode = product.priceMode ?? EcommercePriceMode.FIXED;
  const version = product.version ?? 1;

  let goldValuePaise = 0;
  let makingPaise = 0;
  let makingDiscountPaise = 0;
  let makingAfterPaise = 0;
  let stonesPaise = 0;
  let otherPaise = Math.max(0, product.otherChargesPaise ?? 0);
  let preTaxSubtotalPaise;

  let rateFreshness = null;

  if (priceMode === EcommercePriceMode.FIXED) {
    preTaxSubtotalPaise = activeFixedBasePaise(product, atMs);
    if (preTaxSubtotalPaise <= 0) {
      blockers.push({ code: "FIXED_PRICE_MISSING", message: "Fixed base or sale price is required." });
    }
  } else {
    const weightMg = product.goldWeightMg ?? 0;
    if (weightMg <= 0) {
      blockers.push({ code: "WEIGHT_INVALID", message: "Gold weight must be greater than zero." });
    }
    if (!rateRow?.ratePerGramPaise) {
      blockers.push({
        code: "GOLD_RATE_MISSING",
        message: `No ecommerce gold rate for ${product.purity ?? "—"}.`,
        purity: product.purity ?? null,
      });
    } else {
      rateFreshness = goldRateFreshness(rateRow, atMs, rateMaxAgeMs);
      if (!rateFreshness.fresh) {
        blockers.push({
          code: rateFreshness.code ?? "GOLD_RATE_STALE",
          message:
            rateFreshness.code === "GOLD_RATE_STALE"
              ? `Published ${product.purity} rate is older than ${Math.round(rateMaxAgeMs / 86_400_000)} days. Publish a fresh rate before displaying price.`
              : `Ecommerce gold rate for ${product.purity ?? "—"} is not usable.`,
          purity: product.purity ?? null,
          ageMs: rateFreshness.ageMs,
          maxAgeMs: rateFreshness.maxAgeMs,
        });
      } else {
        goldValuePaise = computeGoldValuePaise(weightMg, rateRow.ratePerGramPaise);
      }
    }
    makingPaise = computeMakingChargePaise({
      mode: product.makingChargeMode,
      goldValuePaise,
      weightMg,
      makingCharge: product.makingCharge ?? {},
    });
    try {
      const offerApplied = applyMakingChargeOffer(makingPaise, product.offer, atMs);
      makingDiscountPaise = offerApplied.discountPaise;
      makingAfterPaise = offerApplied.makingAfterPaise;
    } catch (err) {
      blockers.push({ code: err.code ?? "OFFER_INVALID", message: err.message });
      makingAfterPaise = makingPaise;
    }
    stonesPaise = sumStoneCharges(product);
    preTaxSubtotalPaise = goldValuePaise + makingAfterPaise + stonesPaise + otherPaise;
  }

  const taxRate = resolveTaxRate(taxSettings, product.taxClassification);
  const taxLines = [];
  let taxTotalPaise = 0;
  if (preTaxSubtotalPaise > 0 && taxRate) {
    const taxPaise = mulDivHalfUpPaise(
      preTaxSubtotalPaise,
      Math.max(0, taxRate.rateBps ?? 0),
      10_000,
    );
    taxTotalPaise = taxPaise;
    taxLines.push({
      code: taxRate.code,
      label: taxRate.label ?? taxRate.code,
      rateBps: taxRate.rateBps,
      taxableBasePaise: preTaxSubtotalPaise,
      taxPaise,
    });
  } else if (preTaxSubtotalPaise > 0 && !taxRate) {
    blockers.push({
      code: "TAX_CLASSIFICATION_UNKNOWN",
      message: "Product tax classification is not configured.",
      classification: product.taxClassification ?? null,
    });
  }

  const computable = blockers.length === 0;
  const displayTotalPaise = computable ? addPaise(preTaxSubtotalPaise, taxTotalPaise) : null;

  return {
    priceMode,
    productVersion: version,
    computable,
    blockers,
    contract: {
      taxEstimateScope: "DISPLAY_SINGLE_RATE",
      taxEstimateDisclaimer: ECOMMERCE_TAX_ESTIMATE_DISCLAIMER,
      fixedPriceAllInclusive: priceMode === EcommercePriceMode.FIXED,
      fixedPriceNote:
        priceMode === EcommercePriceMode.FIXED ? ECOMMERCE_FIXED_PRICE_NOTE : null,
      offerAppliesTo:
        priceMode === EcommercePriceMode.GOLD_RATE_BASED ? "MAKING_CHARGE_ONLY" : null,
      offerPolicyNote:
        priceMode === EcommercePriceMode.GOLD_RATE_BASED ? ECOMMERCE_OFFER_POLICY_NOTE : null,
    },
    rateFreshness: rateFreshness ?? (rateRow ? goldRateFreshness(rateRow, atMs, rateMaxAgeMs) : null),
    gold: {
      weightMg: product.goldWeightMg ?? 0,
      purity: product.purity ?? null,
      ratePerGramPaise: rateRow?.ratePerGramPaise ?? null,
      rateId: rateRow?._id ?? rateRow?.id ?? null,
      rateVersion: rateRow?.version ?? null,
      effectiveAt: rateRow?.effectiveAt ?? rateRow?.createdAt ?? null,
      goldValuePaise,
    },
    making: {
      mode: product.makingChargeMode ?? null,
      beforeOfferPaise: makingPaise,
      offerDiscountPaise: makingDiscountPaise,
      afterOfferPaise: makingAfterPaise,
    },
    stonesPaise,
    otherChargesPaise: otherPaise,
    preTaxSubtotalPaise: computable ? preTaxSubtotalPaise : null,
    tax: {
      settingsVersion: taxSettings?.version ?? null,
      classification: product.taxClassification ?? null,
      lines: computable ? taxLines : [],
      totalPaise: computable ? taxTotalPaise : null,
    },
    displayTotalPaise,
  };
}
