import { EcommerceQuoteStatus, EcommerceProductStatus, EcommercePriceMode } from "../constants/enums.js";
import { isEcommerceOperational } from "./ecommerce-access.js";
import { EcommercePaymentMethod } from "../constants/enums.js";
import { assertFulfilmentSelection, mapFulfilmentSettings } from "./ecommerce-fulfilment.js";
import { evaluateCodEligibility } from "./ecommerce-cod.js";
import { evaluateCheckoutTaxReadiness } from "./ecommerce-checkout-tax.js";
import { goldRateFreshness, ECOMMERCE_GOLD_RATE_MAX_AGE_MS } from "./ecommerce-pricing-policy.js";
import {
  EcommerceCategory,
  EcommerceCustomerAddress,
  EcommerceFulfilmentSettings,
  EcommerceGoldRate,
  EcommerceProduct,
  EcommerceStockReservation,
  EcommerceTaxSettings,
} from "../models/index.js";

/** Codes where the customer must request a fresh quote (catalog/pricing/tax/fulfilment changed). */
export const REQUOTE_REQUIRED_CODES = new Set([
  "QUOTE_EXPIRED",
  "QUOTE_NOT_ACTIVE",
  "STORE_NOT_OPERATIONAL",
  "PRODUCT_VERSION_CHANGED",
  "PRODUCT_UNPUBLISHED",
  "PRODUCT_CATEGORY_INACTIVE",
  "GOLD_RATE_CHANGED",
  "GOLD_RATE_STALE",
  "TAX_CONFIG_CHANGED",
  "FULFILMENT_CHARGE_CHANGED",
  "FULFILMENT_UNAVAILABLE",
  "ADDRESS_INVALID",
  "RESERVATION_MISSING",
  "RESERVATION_EXPIRED",
  "QUANTITY_MISMATCH",
  "COD_NOT_AVAILABLE",
  "PAYMENT_METHOD_CHANGED",
]);

/**
 * Server-side gate before order creation (Phase D). Never accepts client totals.
 */
export async function revalidateQuoteForOrder({
  quoteRow,
  tenant,
  customerId,
  session,
  at = new Date(),
}) {
  const blockers = [];
  const quote = quoteRow;

  if (!quote || quote.tenantId !== tenant?._id) {
    return { ok: false, blockers: [{ code: "QUOTE_NOT_FOUND", requiresNewQuote: true }] };
  }
  if (quote.customerId !== customerId) {
    return { ok: false, blockers: [{ code: "QUOTE_OWNERSHIP", requiresNewQuote: false }] };
  }
  if (quote.status !== EcommerceQuoteStatus.ACTIVE) {
    blockers.push({
      code: "QUOTE_NOT_ACTIVE",
      message: `Quote status is ${quote.status}.`,
      requiresNewQuote: true,
    });
  }
  if (new Date(quote.expiresAt) <= at) {
    blockers.push({
      code: "QUOTE_EXPIRED",
      message: "Quote TTL elapsed.",
      requiresNewQuote: true,
    });
  }
  if (!isEcommerceOperational(tenant)) {
    blockers.push({
      code: "STORE_NOT_OPERATIONAL",
      message: "Online store is not active.",
      requiresNewQuote: true,
    });
  }

  const fulfilmentRow = await EcommerceFulfilmentSettings.findOne({ tenantId: quote.tenantId })
    .session(session ?? null)
    .lean();
  const taxSettings = await EcommerceTaxSettings.findOne({ tenantId: quote.tenantId })
    .session(session ?? null)
    .lean();
  const taxReadiness = evaluateCheckoutTaxReadiness(taxSettings, fulfilmentRow ?? {});
  if (!taxReadiness.ready) {
    blockers.push({
      code: "TAX_CONFIG_CHANGED",
      message: "Checkout tax configuration is no longer complete.",
      requiresNewQuote: true,
    });
  }
  const snap = quote.financialSnapshot ?? {};
  if (
    snap.fulfilmentSettingsVersion != null
    && fulfilmentRow?.version != null
    && snap.fulfilmentSettingsVersion !== fulfilmentRow.version
  ) {
    blockers.push({
      code: "TAX_CONFIG_CHANGED",
      message: "Fulfilment/tax settings version changed.",
      requiresNewQuote: true,
    });
  }
  if (
    snap.catalogTaxSettingsVersion != null
    && taxSettings?.version != null
    && snap.catalogTaxSettingsVersion !== taxSettings.version
  ) {
    blockers.push({
      code: "TAX_CONFIG_CHANGED",
      message: "Catalog tax settings version changed.",
      requiresNewQuote: true,
    });
  }

  const fulfilmentSettings = mapFulfilmentSettings(fulfilmentRow ?? {});
  try {
    const selection = assertFulfilmentSelection(fulfilmentSettings, {
      mode: quote.fulfilmentMode,
      pickupBranchId: quote.pickupBranchId ?? snap.pickupBranchId,
      pincode: quote.addressSnapshot?.pincode,
    });
    if (
      selection.fulfilmentChargePaise !== (quote.fulfilmentChargePaise ?? 0)
    ) {
      blockers.push({
        code: "FULFILMENT_CHARGE_CHANGED",
        message: "Delivery/pickup charge no longer matches the quoted amount.",
        requiresNewQuote: true,
      });
    }
  } catch (err) {
    blockers.push({
      code: "FULFILMENT_UNAVAILABLE",
      message: err.message ?? "Fulfilment no longer available.",
      requiresNewQuote: true,
    });
  }

  let addressRow = null;
  if (quote.addressSnapshot?.id) {
    addressRow = await EcommerceCustomerAddress.findOne({
      _id: quote.addressSnapshot.id,
      tenantId: quote.tenantId,
      customerId,
    })
      .session(session ?? null)
      .lean();
    if (!addressRow) {
      blockers.push({
        code: "ADDRESS_INVALID",
        message: "Delivery address was removed.",
        requiresNewQuote: true,
      });
    }
  }

  const paymentMethod = quote.paymentMethod ?? EcommercePaymentMethod.ONLINE;
  if (paymentMethod === EcommercePaymentMethod.COD) {
    const codEval = evaluateCodEligibility({
      tenant,
      taxSettings,
      fulfilmentSettingsRow: fulfilmentRow ?? {},
      fulfilmentMode: quote.fulfilmentMode,
      addressSnapshot: addressRow
        ? {
            id: addressRow._id,
            pincode: addressRow.pincode,
            state: addressRow.state,
          }
        : quote.addressSnapshot,
    });
    if (!codEval.eligible) {
      blockers.push({
        code: "COD_NOT_AVAILABLE",
        message: "Cash on delivery is no longer available for this quote.",
        requiresNewQuote: true,
        details: codEval.blockers,
      });
    } else if (
      quote.codPincodeSnapshot
      && codEval.codPincode
      && quote.codPincodeSnapshot !== codEval.codPincode
    ) {
      blockers.push({
        code: "PAYMENT_METHOD_CHANGED",
        message: "Delivery address pincode changed; request a new quote.",
        requiresNewQuote: true,
      });
    }
  }

  for (const line of quote.lines ?? []) {
    const product = await EcommerceProduct.findOne({
      _id: line.productId,
      tenantId: quote.tenantId,
    })
      .session(session ?? null)
      .lean();
    if (!product || product.status !== EcommerceProductStatus.PUBLISHED) {
      blockers.push({
        code: "PRODUCT_UNPUBLISHED",
        productId: line.productId,
        requiresNewQuote: true,
      });
      continue;
    }
    if ((line.productVersion ?? 0) !== (product.version ?? 0)) {
      blockers.push({
        code: "PRODUCT_VERSION_CHANGED",
        productId: line.productId,
        requiresNewQuote: true,
      });
    }
    if (product.categoryId) {
      const cat = await EcommerceCategory.findOne({
        _id: product.categoryId,
        tenantId: quote.tenantId,
        active: true,
      })
        .session(session ?? null)
        .lean();
      if (!cat) {
        blockers.push({
          code: "PRODUCT_CATEGORY_INACTIVE",
          productId: line.productId,
          requiresNewQuote: true,
        });
      }
    }
    if (product.priceMode === EcommercePriceMode.GOLD_RATE_BASED) {
      const snapRate = line.pricingSnapshot?.rateRow;
      const rateRow = snapRate?.id
        ? await EcommerceGoldRate.findOne({ _id: snapRate.id, tenantId: quote.tenantId })
          .session(session ?? null)
          .lean()
        : null;
      const latest = await EcommerceGoldRate.findOne({
        tenantId: quote.tenantId,
        purity: product.purity,
        effectiveAt: { $lte: at },
      })
        .sort({ effectiveAt: -1, createdAt: -1 })
        .session(session ?? null)
        .lean();
      if (!latest || (snapRate?.id && latest._id !== snapRate.id)) {
        blockers.push({
          code: "GOLD_RATE_CHANGED",
          productId: line.productId,
          requiresNewQuote: true,
        });
      }
      const freshness = goldRateFreshness(latest ?? rateRow, at.getTime(), ECOMMERCE_GOLD_RATE_MAX_AGE_MS);
      if (!freshness.fresh) {
        blockers.push({
          code: "GOLD_RATE_STALE",
          productId: line.productId,
          requiresNewQuote: true,
        });
      }
    }

    const reservation = await EcommerceStockReservation.findOne({
      tenantId: quote.tenantId,
      quoteId: quote._id,
      productId: line.productId,
      releasedAt: null,
      expiresAt: { $gt: at },
    })
      .session(session ?? null)
      .lean();
    const tracked = line.pricingSnapshot?.stockPolicy === "QUANTITY_TRACKED";
    if (tracked) {
      if (!reservation) {
        blockers.push({
          code: "RESERVATION_MISSING",
          productId: line.productId,
          requiresNewQuote: true,
        });
      } else if (reservation.quantity !== line.quantity) {
        blockers.push({
          code: "QUANTITY_MISMATCH",
          productId: line.productId,
          requiresNewQuote: true,
        });
      }
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    quotedTotalPaise: quote.totalPaise ?? 0,
  };
}
