import { EcommercePriceMode } from "../constants/enums.js";
import { errors } from "./app-error.js";

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function coerceScheduleInstant(value, field) {
  if (value === null || value === undefined) return value;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw errors.validation([{ field, message: "Invalid date/time." }]);
  }
  return d;
}

function scheduleInstantMs(value) {
  if (value == null) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

export function mergeFixedPricingPatch(existing, incoming, { replaceEntire = false } = {}) {
  if (incoming === undefined) return existing ?? null;
  if (incoming === null) return null;
  const base = replaceEntire ? {} : { ...(existing ?? {}) };
  if (incoming.basePricePaise !== undefined) base.basePricePaise = incoming.basePricePaise;
  for (const key of ["salePricePaise", "saleStartsAt", "saleEndsAt"]) {
    if (!hasOwn(incoming, key)) continue;
    if (key === "saleStartsAt" || key === "saleEndsAt") {
      base[key] =
        incoming[key] === null
          ? null
          : coerceScheduleInstant(incoming[key], `fixedPricing.${key}`);
    } else {
      base[key] = incoming[key];
    }
  }
  return base;
}

export function mergeOfferPatch(existing, incoming, { replaceEntire = false } = {}) {
  if (incoming === undefined) return existing ?? null;
  if (incoming === null) return null;
  const base = replaceEntire ? {} : { ...(existing ?? {}) };
  if (incoming.type !== undefined) base.type = incoming.type;
  if (hasOwn(incoming, "valuePaise")) base.valuePaise = incoming.valuePaise;
  if (hasOwn(incoming, "percentBps")) base.percentBps = incoming.percentBps;
  for (const key of ["startsAt", "endsAt"]) {
    if (!hasOwn(incoming, key)) continue;
    base[key] =
      incoming[key] === null ? null : coerceScheduleInstant(incoming[key], `offer.${key}`);
  }
  return base;
}

function goldFieldsFromPatch(existing, patch) {
  return {
    purity: hasOwn(patch, "purity") ? patch.purity : existing.purity,
    goldWeightMg: hasOwn(patch, "goldWeightMg") ? patch.goldWeightMg : existing.goldWeightMg,
    makingChargeMode: hasOwn(patch, "makingChargeMode")
      ? patch.makingChargeMode
      : existing.makingChargeMode,
    makingCharge: hasOwn(patch, "makingCharge") ? patch.makingCharge : existing.makingCharge,
    stones: hasOwn(patch, "stones") ? patch.stones : existing.stones,
    stoneChargePaise: hasOwn(patch, "stoneChargePaise")
      ? patch.stoneChargePaise
      : existing.stoneChargePaise,
    otherChargesPaise: hasOwn(patch, "otherChargesPaise")
      ? patch.otherChargesPaise
      : existing.otherChargesPaise,
  };
}

/** Merge pricing-related fields for PATCH; omit nested keys preserve stored values. */
export function buildMergedProductForPatch(existing, patch) {
  const merged = { ...existing, ...patch };
  const modeChanged = hasOwn(patch, "priceMode") && patch.priceMode !== existing.priceMode;
  const nextMode = patch.priceMode ?? existing.priceMode;
  merged.priceMode = nextMode;

  if (modeChanged) {
    if (nextMode === EcommercePriceMode.FIXED) {
      merged.fixedPricing = mergeFixedPricingPatch(
        null,
        patch.fixedPricing ?? {},
        { replaceEntire: true },
      );
      merged.offer = null;
      merged.purity = null;
      merged.goldWeightMg = 0;
      merged.makingChargeMode = null;
      merged.makingCharge = {};
      merged.stones = [];
      merged.stoneChargePaise = null;
      merged.otherChargesPaise = null;
    } else {
      merged.fixedPricing = null;
      Object.assign(merged, goldFieldsFromPatch(existing, patch));
      if (hasOwn(patch, "offer")) {
        merged.offer = mergeOfferPatch(null, patch.offer, { replaceEntire: true });
      } else {
        merged.offer = existing.offer ?? null;
      }
    }
  } else if (nextMode === EcommercePriceMode.FIXED) {
    if (hasOwn(patch, "fixedPricing")) {
      merged.fixedPricing = mergeFixedPricingPatch(existing.fixedPricing, patch.fixedPricing);
    } else {
      merged.fixedPricing = existing.fixedPricing ?? null;
    }
    if (hasOwn(patch, "offer")) {
      merged.offer = patch.offer === null ? null : mergeOfferPatch(existing.offer, patch.offer);
    } else {
      merged.offer = existing.offer ?? null;
    }
  } else {
    merged.fixedPricing = existing.fixedPricing ?? null;
    Object.assign(merged, goldFieldsFromPatch(existing, patch));
    if (hasOwn(patch, "offer")) {
      merged.offer = mergeOfferPatch(existing.offer, patch.offer);
    } else {
      merged.offer = existing.offer ?? null;
    }
  }

  return merged;
}

export function validateProductScheduleWindows(product) {
  const issues = [];
  if (product.priceMode === EcommercePriceMode.FIXED && product.fixedPricing) {
    const fixed = product.fixedPricing;
    const start = scheduleInstantMs(fixed.saleStartsAt);
    const end = scheduleInstantMs(fixed.saleEndsAt);
    if (start != null && end != null && start > end) {
      issues.push({
        field: "fixedPricing.saleEndsAt",
        message: "Sale end must be on or after sale start.",
      });
    }
  }
  if (product.priceMode === EcommercePriceMode.GOLD_RATE_BASED && product.offer) {
    const start = scheduleInstantMs(product.offer.startsAt);
    const end = scheduleInstantMs(product.offer.endsAt);
    if (start != null && end != null && start > end) {
      issues.push({
        field: "offer.endsAt",
        message: "Offer end must be on or after offer start.",
      });
    }
  }
  if (issues.length) throw errors.validation(issues);
}

export const PRICING_PATCH_KEYS = [
  "priceMode",
  "fixedPricing",
  "offer",
  "purity",
  "goldWeightMg",
  "makingChargeMode",
  "makingCharge",
  "stones",
  "stoneChargePaise",
  "otherChargesPaise",
];

function patchTouchesPricing(patch) {
  return PRICING_PATCH_KEYS.some((key) => hasOwn(patch, key));
}

/** Assign merged pricing only when the request touched pricing fields. */
export function pricingFieldsFromPatchAssign(merged, patch) {
  if (!patchTouchesPricing(patch)) return {};
  const out = {};
  for (const key of PRICING_PATCH_KEYS) {
    out[key] = merged[key];
  }
  return out;
}
