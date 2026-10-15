import {
  EcommercePriceMode,
  EcommercePromotionKind,
} from "../constants/enums.js";
import { AppError } from "../lib/app-error.js";
import {
  applyMakingChargeOffer,
  computeProductPriceEstimate,
} from "../lib/ecommerce-pricing.js";
import { sha256 } from "../lib/crypto.js";
import { moneyRef } from "../lib/money.js";
import { EcommerceGoldRate } from "../models/index.js";
import { loadTaxSettings } from "../services/ecommerce.service.js";

const TITLE_MAX = 120;
const BODY_MAX = 500;
const REVISION_DIGEST_LEN = 64;

export function trimPromotionCopy(title, body) {
  const t = String(title ?? "").trim();
  const b = String(body ?? "").trim();
  if (t.length < 2 || t.length > TITLE_MAX) {
    throw new AppError("INVALID_TITLE", `Title must be 2–${TITLE_MAX} characters.`, 422);
  }
  if (b.length < 2 || b.length > BODY_MAX) {
    throw new AppError("INVALID_BODY", `Message must be 2–${BODY_MAX} characters.`, 422);
  }
  return { title: t, body: b };
}

export function productShopDeepLink(slug) {
  return `/shop/${encodeURIComponent(String(slug).trim())}`;
}

export function categoryShopDeepLink(categoryId) {
  return `/shop?categoryId=${encodeURIComponent(String(categoryId))}`;
}

async function latestRateForPurity(tenantId, purity, at = new Date()) {
  if (!purity) return null;
  return EcommerceGoldRate.findOne({
    tenantId,
    purity,
    effectiveAt: { $lte: at },
  })
    .sort({ effectiveAt: -1, createdAt: -1 })
    .lean();
}

async function pricingContext(tenantId, product) {
  const taxSettings = await loadTaxSettings(tenantId);
  const rateRow =
    product.priceMode === EcommercePriceMode.GOLD_RATE_BASED
      ? await latestRateForPurity(tenantId, product.purity)
      : null;
  return { taxSettings, rateRow };
}

export function suggestProductPromotionCopy(product, estimate) {
  const name = product.name?.trim() || "New item";
  let body = `Discover ${name} in our shop.`;
  const totalDisplay = estimate?.displayTotalPaise != null
    ? moneyRef(estimate.displayTotalPaise).amountDisplay
    : null;
  if (product.priceMode === EcommercePriceMode.FIXED && totalDisplay) {
    body = `${name} — from ${totalDisplay} in our shop.`;
  } else if (product.priceMode === EcommercePriceMode.GOLD_RATE_BASED && totalDisplay) {
    body = `${name} — current estimate ${totalDisplay} (gold rate & GST apply).`;
  }
  return { title: "New in the shop", body };
}

export function suggestCategoryPromotionCopy(category) {
  const name = category.name?.trim() || "Collection";
  return {
    title: "Shop collection",
    body: `Browse ${name} in our online store.`,
  };
}

function isoOrNull(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalizedOfferRevisionPayload(product) {
  const fixed = product.fixedPricing ?? {};
  if (product.priceMode === EcommercePriceMode.FIXED) {
    return {
      mode: "FIXED",
      salePricePaise: fixed.salePricePaise ?? null,
      saleStartsAt: isoOrNull(fixed.saleStartsAt),
      saleEndsAt: isoOrNull(fixed.saleEndsAt),
    };
  }
  const offer = product.offer ?? null;
  return {
    mode: "GOLD",
    offer: offer
      ? {
          type: offer.type ?? null,
          valuePaise: offer.valuePaise ?? null,
          percentBps: offer.percentBps ?? null,
          startsAt: isoOrNull(offer.startsAt),
          endsAt: isoOrNull(offer.endsAt),
        }
      : null,
  };
}

export function offerRevisionDigest(product) {
  return sha256(JSON.stringify(normalizedOfferRevisionPayload(product))).slice(0, REVISION_DIGEST_LEN);
}

export function offerRevisionKey(product) {
  return offerRevisionDigest(product);
}

export function hasNotifiableOffer(product, atMs = Date.now()) {
  if (product.priceMode === EcommercePriceMode.FIXED) {
    const fixed = product.fixedPricing ?? {};
    if (fixed.salePricePaise == null || fixed.salePricePaise < 0) return false;
    const to = fixed.saleEndsAt ? new Date(fixed.saleEndsAt).getTime() : null;
    if (to != null && to < atMs) return false;
    const base = fixed.basePricePaise;
    if (base != null && fixed.salePricePaise >= base) return false;
    return true;
  }
  const offer = product.offer;
  if (!offer?.type) return false;
  if (offer.endsAt && new Date(offer.endsAt).getTime() < atMs) return false;
  return true;
}

export function hasOfferBenefit(product, estimate, atMs = Date.now()) {
  if (!hasNotifiableOffer(product, atMs)) return false;
  if (product.priceMode === EcommercePriceMode.FIXED) return true;
  const discount = estimate?.making?.offerDiscountPaise ?? 0;
  if (discount > 0) return true;
  const before = estimate?.making?.beforeOfferPaise ?? 0;
  try {
    const applied = applyMakingChargeOffer(before, product.offer, atMs);
    return applied.discountPaise > 0;
  } catch {
    return false;
  }
}

export function resolvePromotionSchedule(product, atMs = Date.now()) {
  if (product.priceMode === EcommercePriceMode.FIXED) {
    const fixed = product.fixedPricing ?? {};
    if (fixed.saleStartsAt && new Date(fixed.saleStartsAt).getTime() > atMs) {
      return new Date(fixed.saleStartsAt);
    }
  }
  const offer = product.offer;
  if (offer?.startsAt && new Date(offer.startsAt).getTime() > atMs) {
    return new Date(offer.startsAt);
  }
  return null;
}

export function suggestOfferPromotionCopy(product, estimate, atMs = Date.now()) {
  const name = product.name?.trim() || "Item";
  if (product.priceMode === EcommercePriceMode.FIXED) {
    const displayPaise = estimate?.displayTotalPaise ?? product.fixedPricing?.salePricePaise;
    const saleDisplay = displayPaise != null ? moneyRef(displayPaise).amountDisplay : null;
    if (saleDisplay) {
      return {
        title: "Special price",
        body: `${name} — now ${saleDisplay} in our shop.`,
      };
    }
  }
  const discountPaise = estimate?.making?.offerDiscountPaise ?? 0;
  if (discountPaise > 0) {
    const offDisplay = moneyRef(discountPaise).amountDisplay;
    return {
      title: "Offer on making charges",
      body: `${name} — save ${offDisplay} on making charges. Shop now.`,
    };
  }
  const before = estimate?.making?.beforeOfferPaise ?? 0;
  try {
    const applied = applyMakingChargeOffer(before, product.offer, atMs);
    if (applied.discountPaise > 0) {
      const offDisplay = moneyRef(applied.discountPaise).amountDisplay;
      return {
        title: "Offer on making charges",
        body: `${name} — save ${offDisplay} on making charges. Shop now.`,
      };
    }
  } catch {
    /* fall through */
  }
  return suggestProductPromotionCopy(product, estimate);
}

export async function resolveCampaignCopy({
  kind,
  product,
  category,
  title,
  body,
  tenantId,
  atMs = Date.now(),
}) {
  if (kind === EcommercePromotionKind.MANUAL_CATEGORY && category) {
    const suggested = suggestCategoryPromotionCopy(category);
    return trimPromotionCopy(title?.trim() || suggested.title, body?.trim() || suggested.body);
  }
  if (!product) {
    throw new AppError("INVALID_TARGET", "Product is required for this promotion.", 422);
  }
  const { taxSettings, rateRow } = await pricingContext(tenantId, product);
  const estimate = computeProductPriceEstimate({ product, rateRow, taxSettings, atMs });
  if (kind === EcommercePromotionKind.OFFER) {
    if (!hasOfferBenefit(product, estimate, atMs)) {
      throw new AppError("OFFER_INACTIVE", "No active offer benefit to promote.", 422);
    }
    const suggested = suggestOfferPromotionCopy(product, estimate, atMs);
    return trimPromotionCopy(title?.trim() || suggested.title, body?.trim() || suggested.body);
  }
  const suggested = suggestProductPromotionCopy(product, estimate);
  return trimPromotionCopy(title?.trim() || suggested.title, body?.trim() || suggested.body);
}
