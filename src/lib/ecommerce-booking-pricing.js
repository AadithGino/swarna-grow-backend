import { AppError } from "./app-error.js";
import { addPaise } from "./ecommerce-exact-money.js";
import { computeProductPriceEstimate } from "./ecommerce-pricing.js";
import { chooseBillingRate } from "./ecommerce-booking-policy.js";
import {
  computeComponentTaxPaise,
  evaluateCheckoutTaxReadiness,
  resolveProductHsnSac,
} from "./ecommerce-checkout-tax.js";
import {
  isDestinationStateSupported,
  pickComponentLinesForSupplyCase,
  resolveDestinationState,
  resolveSupplyCase,
} from "./ecommerce-place-of-supply.js";
import { assertFulfilmentSelection, mapFulfilmentSettings } from "./ecommerce-fulfilment.js";
import {
  EcommerceCheckoutTaxPresentation,
  EcommerceFulfilmentMode,
  EcommercePaymentMethod,
  EcommercePriceMode,
} from "../constants/enums.js";
import { EcommerceFulfilmentSettings, EcommerceGoldRate, EcommerceTaxSettings } from "../models/index.js";

/**
 * Booking pricing for branch pickup. It follows the same steps as the checkout quote (display
 * estimate from computeProductPriceEstimate, then component tax for the supply case, HSN/SAC
 * check) so a booking invoice and a checkout invoice for the same product, rate and settings are
 * the same number. Delivery bookings are outside release 1.
 */

const MODE = EcommerceFulfilmentMode.BRANCH_PICKUP;

export async function latestRateForPurity(tenantId, purity, session) {
  if (!purity) return null;
  const q = EcommerceGoldRate.findOne({ tenantId, purity, effectiveAt: { $lte: new Date() } })
    .sort({ effectiveAt: -1, createdAt: -1 });
  return session ? q.session(session).lean() : q.lean();
}

/** Tax and fulfilment context for pricing one pickup booking. Throws when checkout is not ready. */
export async function loadBookingPricingContext({ tenantId, pickupBranchId, session }) {
  const fulfilmentQuery = EcommerceFulfilmentSettings.findOne({ tenantId });
  const fulfilmentRow = await (session ? fulfilmentQuery.session(session) : fulfilmentQuery);
  const fulfilment = fulfilmentRow?.toObject?.() ?? fulfilmentRow ?? {};
  const taxQuery = EcommerceTaxSettings.findOne({ tenantId });
  const taxSettings = await (session ? taxQuery.session(session).lean() : taxQuery.lean());

  const readiness = evaluateCheckoutTaxReadiness(taxSettings, fulfilment);
  if (!readiness.ready) {
    throw new AppError("CHECKOUT_NOT_READY", "Checkout tax configuration is incomplete.", 422, { blockers: readiness.blockers });
  }
  const { fulfilmentChargePaise } = assertFulfilmentSelection(mapFulfilmentSettings(fulfilment), {
    mode: MODE,
    pickupBranchId,
  });
  const checkoutTaxConfig = fulfilment.checkoutTaxConfig ?? {};
  const destinationState = resolveDestinationState({ fulfilmentMode: MODE, addressSnapshot: null, checkoutTaxConfig });
  if (!isDestinationStateSupported(checkoutTaxConfig, destinationState)) {
    throw new AppError("CHECKOUT_NOT_READY", "The pickup branch's state is not supported for checkout.", 422, {
      blockers: [{ code: "UNSUPPORTED_DESTINATION", destinationState }],
    });
  }
  const supplyCase = resolveSupplyCase(checkoutTaxConfig.registeredState, destinationState);
  if (!supplyCase) {
    throw new AppError("CHECKOUT_NOT_READY", "Place of supply could not be determined.", 422, {
      blockers: [{ code: "MISSING_PLACE_OF_SUPPLY" }],
    });
  }
  const componentLines = pickComponentLinesForSupplyCase(checkoutTaxConfig, supplyCase);
  if (!componentLines.length) {
    throw new AppError("CHECKOUT_NOT_READY", "No accountant-approved component tax rules for this supply case.", 422, {
      blockers: [{ code: "MISSING_SUPPLY_CASE_TAX_RULES", supplyCase }],
    });
  }
  return {
    taxSettings,
    fulfilment,
    fulfilmentChargePaise,
    destinationState,
    supplyCase,
    componentLines,
    pickupBranchId,
  };
}

/** The gold rate to book with an advance: the live row the advance was quoted from. */
export function bookedRateFromRow(rateRow) {
  if (!rateRow?.ratePerGramPaise) return null;
  return {
    ratePerGramPaise: rateRow.ratePerGramPaise,
    purity: rateRow.purity,
    rateId: rateRow._id ?? null,
    rateVersion: rateRow.version ?? null,
    savedAt: rateRow.effectiveAt ?? rateRow.createdAt ?? null,
  };
}

function notComputable(product, blockers) {
  return new AppError("PRICE_NOT_COMPUTABLE", `Price cannot be computed for ${product.name}.`, 422, {
    productId: product._id,
    blockers,
  });
}

/** Pure: the invoice for one booked unit, in the same shape the checkout quote produces. */
export function buildBookingInvoice({ product, estimate, context, stockPolicy, rateRow = null, rateSource, atMs }) {
  const hsnSac = resolveProductHsnSac(product.toObject?.() ?? product, context.taxSettings);
  if (!hsnSac.ok) {
    throw new AppError("CHECKOUT_NOT_READY", `HSN/SAC mapping is missing for ${product.name}.`, 422, {
      productId: product._id,
      code: hsnSac.code,
    });
  }
  const unitPreTaxPaise = estimate.preTaxSubtotalPaise ?? 0;
  const lineTax = computeComponentTaxPaise(unitPreTaxPaise, context.componentLines);
  const subtotalPaise = unitPreTaxPaise;
  const taxPaise = lineTax.totalPaise;
  const fulfilmentChargePaise = context.fulfilmentChargePaise ?? 0;
  const totalPaise = addPaise(addPaise(subtotalPaise, taxPaise), fulfilmentChargePaise);
  const lines = [{
    productId: product._id,
    productVersion: product.version ?? 1,
    name: product.name,
    sku: product.sku ?? "",
    quantity: 1,
    unitPricePaise: unitPreTaxPaise,
    lineTotalPaise: unitPreTaxPaise,
    pricingSnapshot: {
      stockPolicy,
      estimate,
      hsnSac,
      componentTax: lineTax,
      rateSource,
      rateRow: rateRow
        ? {
            id: rateRow._id,
            purity: rateRow.purity,
            ratePerGramPaise: rateRow.ratePerGramPaise,
            effectiveAt: rateRow.effectiveAt,
            version: rateRow.version,
          }
        : null,
    },
  }];
  const financialSnapshot = {
    subtotalPaise,
    taxPaise,
    fulfilmentChargePaise,
    totalPaise,
    taxComponentLines: context.componentLines,
    supplyCase: context.supplyCase,
    destinationState: context.destinationState,
    placeOfSupplyState: context.destinationState,
    catalogTaxSettingsVersion: context.taxSettings?.version ?? 1,
    fulfilmentSettingsVersion: context.fulfilment?.version ?? 1,
    taxPresentation: EcommerceCheckoutTaxPresentation.ACCOUNTANT_COMPONENT_APPROVED,
    pickupBranchId: context.pickupBranchId,
    quotedAt: new Date(atMs).toISOString(),
    paymentMethod: EcommercePaymentMethod.ONLINE,
    codPincodeSnapshot: null,
    rateSource,
  };
  return { subtotalPaise, taxPaise, fulfilmentChargePaise, totalPaise, lines, financialSnapshot, rateSource };
}

/**
 * Pure: price one booked unit.
 *
 * ADVANCE_QUOTE prices at the live rate (the rate that is then booked). FINAL applies the policy's
 * rate rule: the booked rate where the rule and protection window allow it, otherwise a live rate.
 * Whenever a live rate is required it goes through the normal freshness check inside the estimate,
 * so a stale or missing rate blocks pricing instead of silently falling back to the booked one.
 */
export function priceBookingInvoice({
  product,
  context,
  stage,
  rateRule = null,
  bookedRate = null,
  liveRateRow = null,
  stockPolicy,
  at = new Date(),
}) {
  const atMs = new Date(at).getTime();
  const priceMode = product.priceMode ?? EcommercePriceMode.FIXED;
  const estimateWith = (options) =>
    computeProductPriceEstimate({ product, taxSettings: context.taxSettings, atMs, ...options });

  let estimate;
  let rateRow = null;
  let rateSource;
  if (priceMode === EcommercePriceMode.FIXED) {
    estimate = estimateWith({});
    rateSource = "FIXED";
  } else if (stage === "ADVANCE_QUOTE") {
    estimate = estimateWith({ rateRow: liveRateRow });
    rateRow = liveRateRow;
    rateSource = "LIVE";
  } else {
    const choice = chooseBillingRate({
      rateRule,
      bookedRate,
      liveRatePerGramPaise: liveRateRow?.ratePerGramPaise ?? null,
      at,
    });
    if (choice.needsFreshRate) {
      const live = estimateWith({ rateRow: liveRateRow });
      // A live rate that cannot be used blocks the invoice, even when the booked rate would be chosen.
      if (!live.computable) throw notComputable(product, live.blockers);
      estimate = choice.savedRate ? estimateWith({ savedRate: choice.savedRate }) : live;
      rateRow = choice.savedRate ? null : liveRateRow;
    } else {
      estimate = estimateWith({ savedRate: choice.savedRate });
    }
    rateSource = choice.source;
  }
  if (!estimate.computable || estimate.preTaxSubtotalPaise == null) throw notComputable(product, estimate.blockers);
  return buildBookingInvoice({ product, estimate, context, stockPolicy, rateRow, rateSource, atMs });
}
