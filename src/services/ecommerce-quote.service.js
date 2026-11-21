import { customerHasOnlineSchemeAllocation, schemeHasOnlineAllocation } from "../lib/ecommerce-scheme-online-use.js";
import { getSchemePurchaseEntitlement } from "./ecommerce-scheme-reservation.service.js";
import { previewSchemePurchase } from "../lib/ecommerce-scheme-purchase-preview.js";
import { assertRedemptionKyc, OPEN_REDEMPTION_STATUSES, settlementPreview } from "./redemption.service.js";
import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { assertEcommerceOperational } from "../lib/ecommerce-access.js";
import { addPaise } from "../lib/ecommerce-exact-money.js";
import { computeProductPriceEstimate } from "../lib/ecommerce-pricing.js";
import {
  computeComponentTaxPaise,
  evaluateCheckoutTaxReadiness,
  resolveProductHsnSac,
} from "../lib/ecommerce-checkout-tax.js";
import {
  isDestinationStateSupported,
  pickComponentLinesForSupplyCase,
  resolveDestinationState,
  resolveSupplyCase,
} from "../lib/ecommerce-place-of-supply.js";
import {
  assertFulfilmentSelection,
  mapFulfilmentSettings,
} from "../lib/ecommerce-fulfilment.js";
import { loadInventoryAvailability } from "../lib/ecommerce-inventory.js";
import { testPaymentHarnessMetaForClient } from "./ecommerce-test-payment-completion.service.js";
import {
  cancelActiveQuoteRow,
  expireActiveQuoteRow,
  expireQuoteByTimeIfActive,
} from "../lib/ecommerce-quote-lifecycle.js";
import { revalidateQuoteForOrder } from "../lib/ecommerce-quote-revalidation.js";
import { reserveStockForQuote } from "../lib/ecommerce-stock-reserve.js";
import { deriveEcommerceCheckoutCapability } from "../lib/ecommerce-checkout-capability.js";
import { tenantForEcommerceCheckout } from "../lib/ecommerce-checkout-tenant.js";
import { logQuoteCapabilityDebug } from "../lib/ecommerce-quote-capability-debug.js";
import { hashIdempotencyBody } from "./idempotency.service.js";
import {
  EcommerceCart,
  EcommerceCategory,
  EcommerceCustomerAddress,
  EcommerceFulfilmentSettings,
  EcommerceGoldRate,
  EcommercePriceQuote,
  EcommerceProduct,
  EcommerceTaxSettings,
  Redemption,
  Scheme,
} from "../models/index.js";
import {
  assertQuotePaymentMethodAllowed,
  derivePaymentMethodOptions,
  evaluateCodEligibility,
  resolveQuotePaymentMethod,
} from "../lib/ecommerce-cod.js";
import {
  ClosureType,
  RedemptionMode,
  EcommerceCheckoutTaxPresentation,
  EcommerceFulfilmentMode,
  EcommercePaymentMethod,
  EcommercePriceMode,
  EcommerceProductStatus,
  EcommerceQuoteStatus,
  EcommerceStockPolicy,
} from "../constants/enums.js";

export const QUOTE_TTL_MS = 15 * 60 * 1000;

export { revalidateQuoteForOrder };

async function loadTaxSettings(tenantId, session) {
  const q = EcommerceTaxSettings.findOne({ tenantId });
  return session ? q.session(session).lean() : q.lean();
}

async function latestRateForPurity(tenantId, purity, session) {
  if (!purity) return null;
  const q = EcommerceGoldRate.findOne({
    tenantId,
    purity,
    effectiveAt: { $lte: new Date() },
  }).sort({ effectiveAt: -1, createdAt: -1 });
  return session ? q.session(session).lean() : q.lean();
}

async function loadCheckoutCapability(tenantId, tenantLite) {
  const tenant = await tenantForEcommerceCheckout(tenantId, tenantLite);
  const fulfilmentRow = await EcommerceFulfilmentSettings.findOne({ tenantId }).lean();
  const taxSettings = await EcommerceTaxSettings.findOne({ tenantId }).lean();
  return deriveEcommerceCheckoutCapability({
    taxSettings,
    fulfilmentSettingsRow: fulfilmentRow ?? {},
    tenant,
  });
}

function mapQuote(row, capability, methodOptions = null) {
  const snap = row.financialSnapshot ?? {};
  const cap = capability ?? { paymentAllowed: false, checkoutUsable: false };
  const paymentMethod = row.paymentMethod ?? snap.paymentMethod ?? EcommercePaymentMethod.ONLINE;
  const options =
    methodOptions
    ?? derivePaymentMethodOptions({
      capability: cap,
      codEvaluation: { eligible: false, blockers: [] },
    });
  const orderPlacementAllowed =
    paymentMethod === EcommercePaymentMethod.COD
      ? options.orderPlacement[EcommercePaymentMethod.COD] === true
      : options.orderPlacement[EcommercePaymentMethod.ONLINE] === true;
  return {
    id: row._id,
    status: row.status,
    lines: row.lines ?? [],
    fulfilmentMode: row.fulfilmentMode,
    pickupBranchId: row.pickupBranchId ?? snap.pickupBranchId ?? null,
    addressSnapshot: row.addressSnapshot ?? null,
    fulfilmentChargePaise: row.fulfilmentChargePaise ?? 0,
    subtotalPaise: row.subtotalPaise ?? 0,
    taxPaise: row.taxPaise ?? 0,
    totalPaise: row.totalPaise ?? 0,
    taxComponentLines: snap.taxComponentLines ?? [],
    financialSnapshot: snap,
    expiresAt: row.expiresAt,
    version: row.version ?? 1,
    paymentMethod,
    codPincodeSnapshot: row.codPincodeSnapshot ?? snap.codPincodeSnapshot ?? null,
    paymentAllowed: cap.paymentAllowed,
    orderPlacementAllowed,
    paymentMethods: options.paymentMethods,
    checkoutUsable: cap.checkoutUsable,
    checkoutTaxReady: cap.checkoutTaxReady ?? false,
    previewOnly:
      paymentMethod === EcommercePaymentMethod.ONLINE ? !cap.paymentAllowed : !orderPlacementAllowed,
    blockers: cap.blockers ?? [],
    testPaymentHarness:
      paymentMethod === EcommercePaymentMethod.COD ? null : testPaymentHarnessMetaForClient(),
  };
}

async function replayQuoteByIdempotencyKey(req, session) {
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  const bodyHash = hashIdempotencyBody(req.body);
  const existing = await EcommercePriceQuote.findOne({
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
    idempotencyKey,
  }).session(session);
  if (!existing) return null;
  if (existing.creationBodyHash && existing.creationBodyHash !== bodyHash) {
    throw errors.conflict(
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was already used with a different request.",
    );
  }
  let row = existing.toObject();
  if (row.status === EcommerceQuoteStatus.ACTIVE && new Date(row.expiresAt) <= new Date()) {
    const expired = await expireActiveQuoteRow(row._id, req.auth.tenantId, session);
    row = expired?.toObject?.() ?? { ...row, status: EcommerceQuoteStatus.EXPIRED };
  }
  const capability = await loadCheckoutCapability(req.auth.tenantId, req.tenant);
  const tenant = await tenantForEcommerceCheckout(req.auth.tenantId, req.tenant);
  const fulfilmentRow = await EcommerceFulfilmentSettings.findOne({
    tenantId: req.auth.tenantId,
  }).session(session);
  const taxSettings = await loadTaxSettings(req.auth.tenantId, session);
  const codEvaluation = evaluateCodEligibility({
    tenant,
    taxSettings,
    fulfilmentSettingsRow: fulfilmentRow?.toObject?.() ?? fulfilmentRow ?? {},
    fulfilmentMode: row.fulfilmentMode,
    addressSnapshot: row.addressSnapshot,
  });
  const methodOptions = derivePaymentMethodOptions({ capability, codEvaluation });
  return { quote: mapQuote(row, capability, methodOptions), created: false };
}

async function assertProductQuotable(product, tenantId, session) {
  if (product.status !== EcommerceProductStatus.PUBLISHED) {
    throw errors.business("PRODUCT_NOT_AVAILABLE", "Product is not published.", { productId: product._id });
  }
  if (product.categoryId) {
    const cat = await EcommerceCategory.findOne({
      _id: product.categoryId,
      tenantId,
      active: true,
    }).session(session);
    if (!cat) {
      throw errors.business("PRODUCT_NOT_AVAILABLE", "Product category is not active.", {
        productId: product._id,
      });
    }
  }
}

/**
 * @param {object} req  customer-bound request (req.auth.id = customer)
 * @param {{ lines?: Array<{ productId: string, quantity: number }>, assistedByUserId?: string }} [opts]
 *   staff counter orders pass lines directly instead of reading the customer's cart
 */
export async function createCustomerQuote(req, opts = {}) {
  assertEcommerceOperational(req.tenant);
  const capability = await loadCheckoutCapability(req.auth.tenantId, req.tenant);
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
  }

  const bodyHash = hashIdempotencyBody(req.body);
  try {
    return await withTransaction(async (session) => {
      const replay = await replayQuoteByIdempotencyKey(req, session);
      if (replay) return replay;

      const fulfilmentRow = await EcommerceFulfilmentSettings.findOne({
        tenantId: req.auth.tenantId,
      }).session(session);
      const fulfilmentSettings = mapFulfilmentSettings(fulfilmentRow?.toObject?.() ?? fulfilmentRow ?? {});
      const taxSettings = await loadTaxSettings(req.auth.tenantId, session);
      const taxReadiness = evaluateCheckoutTaxReadiness(
        taxSettings,
        fulfilmentRow?.toObject?.() ?? fulfilmentRow ?? {},
      );
      if (!taxReadiness.ready) {
        throw new AppError(
          "CHECKOUT_NOT_READY",
          "Checkout tax configuration is incomplete.",
          422,
          { blockers: taxReadiness.blockers },
        );
      }

      const mode = req.body.fulfilmentMode;
      const pickupBranchId =
        mode === EcommerceFulfilmentMode.BRANCH_PICKUP
          ? String(req.body.pickupBranchId ?? "").trim()
          : null;
      let fulfilmentChargePaise = 0;
      let addressSnapshot = null;
      if (mode === EcommerceFulfilmentMode.BRANCH_PICKUP) {
        ({ fulfilmentChargePaise } = assertFulfilmentSelection(fulfilmentSettings, {
          mode,
          pickupBranchId,
        }));
      } else if (mode === EcommerceFulfilmentMode.DELIVERY) {
        const addressId = String(req.body.addressId ?? "").trim();
        if (!addressId) {
          throw errors.validation([{ field: "addressId", message: "Delivery address is required." }]);
        }
        const address = await EcommerceCustomerAddress.findOne({
          _id: addressId,
          tenantId: req.auth.tenantId,
          customerId: req.auth.id,
        }).session(session);
        if (!address) throw errors.notFound("Address");
        addressSnapshot = {
          id: address._id,
          recipientName: address.recipientName,
          line1: address.line1,
          line2: address.line2,
          city: address.city,
          state: address.state,
          pincode: address.pincode,
        };
        ({ fulfilmentChargePaise } = assertFulfilmentSelection(fulfilmentSettings, {
          mode,
          pincode: address.pincode,
        }));
      }

      const paymentMethod = resolveQuotePaymentMethod(req.body);
      const tenantCheckout = await tenantForEcommerceCheckout(req.auth.tenantId, req.tenant);
      const codEvaluation = evaluateCodEligibility({
        tenant: tenantCheckout,
        taxSettings,
        fulfilmentSettingsRow: fulfilmentRow?.toObject?.() ?? fulfilmentRow ?? {},
        fulfilmentMode: mode,
        addressSnapshot,
      });
      assertQuotePaymentMethodAllowed(paymentMethod, codEvaluation);
      const codPincodeSnapshot =
        paymentMethod === EcommercePaymentMethod.COD ? codEvaluation.codPincode ?? null : null;

      const cartLines = Array.isArray(opts.lines)
        ? opts.lines
        : ((
            await EcommerceCart.findOne({
              tenantId: req.auth.tenantId,
              customerId: req.auth.id,
            }).session(session)
          )?.lines ?? []);
      if (!cartLines.length) {
        throw errors.validation([{ field: "cart", message: "Cart is empty." }]);
      }

      const checkoutTaxConfig = fulfilmentRow?.checkoutTaxConfig ?? {};
      const destinationState = resolveDestinationState({
        fulfilmentMode: mode,
        addressSnapshot,
        checkoutTaxConfig,
      });
      if (!isDestinationStateSupported(checkoutTaxConfig, destinationState)) {
        const allowed = checkoutTaxConfig?.supportedDestinationStates ?? [];
        const hint =
          allowed.length > 0
            ? `Use delivery state: ${allowed.join(", ")}.`
            : "Update the delivery address state to match checkout tax settings.";
        throw new AppError(
          "CHECKOUT_NOT_READY",
          `Destination state "${destinationState || "(missing)"}" is not supported for checkout. ${hint}`,
          422,
          {
            code: "UNSUPPORTED_DESTINATION",
            destinationState,
            supportedDestinationStates: allowed,
            blockers: [
              {
                code: "UNSUPPORTED_DESTINATION",
                message: `Address state must be one of: ${allowed.length ? allowed.join(", ") : "configured destinations"}.`,
              },
            ],
          },
        );
      }
      const supplyCase = resolveSupplyCase(
        checkoutTaxConfig.registeredState,
        destinationState,
      );
      if (!supplyCase) {
        throw new AppError(
          "CHECKOUT_NOT_READY",
          "Place of supply could not be determined.",
          422,
          { blockers: [{ code: "MISSING_PLACE_OF_SUPPLY" }] },
        );
      }
      const componentLines = pickComponentLinesForSupplyCase(checkoutTaxConfig, supplyCase);
      if (!componentLines.length) {
        throw new AppError(
          "CHECKOUT_NOT_READY",
          "No accountant-approved component tax rules for this supply case.",
          422,
          { blockers: [{ code: "MISSING_SUPPLY_CASE_TAX_RULES", supplyCase }] },
        );
      }
      const quoteLines = [];
      let subtotalPaise = 0;
      let taxPaise = 0;
      const reserveLines = [];

      for (const line of cartLines) {
        const product = await EcommerceProduct.findOne({
          _id: line.productId,
          tenantId: req.auth.tenantId,
        }).session(session);
        if (!product) {
          throw errors.business("PRODUCT_NOT_AVAILABLE", "A cart item is no longer available.", {
            productId: line.productId,
          });
        }
        await assertProductQuotable(product, req.auth.tenantId, session);
        const availability = await loadInventoryAvailability(
          req.auth.tenantId,
          product._id,
          session,
        );
        if (
          availability.stockPolicy === EcommerceStockPolicy.QUANTITY_TRACKED
          && line.quantity > (availability.availableQuantity ?? 0)
        ) {
          throw new AppError(
            "INSUFFICIENT_STOCK",
            `Only ${availability.availableQuantity ?? 0} units available for ${product.name}.`,
            422,
            { productId: product._id },
          );
        }
        const rateRow =
          product.priceMode === EcommercePriceMode.GOLD_RATE_BASED
            ? await latestRateForPurity(req.auth.tenantId, product.purity, session)
            : null;
        const estimate = computeProductPriceEstimate({
          product,
          rateRow,
          taxSettings,
        });
        if (!estimate.computable || estimate.preTaxSubtotalPaise == null) {
          throw new AppError(
            "PRICE_NOT_COMPUTABLE",
            `Price cannot be computed for ${product.name}.`,
            422,
            { productId: product._id, blockers: estimate.blockers },
          );
        }
        const hsnSac = resolveProductHsnSac(product.toObject?.() ?? product, taxSettings);
        if (!hsnSac.ok) {
          throw new AppError(
            "CHECKOUT_NOT_READY",
            `HSN/SAC mapping is missing for ${product.name}.`,
            422,
            { productId: product._id, code: hsnSac.code },
          );
        }
        const unitPreTaxPaise = estimate.preTaxSubtotalPaise ?? 0;
        const linePreTaxPaise = unitPreTaxPaise * line.quantity;
        subtotalPaise = addPaise(subtotalPaise, linePreTaxPaise);
        const lineTax = computeComponentTaxPaise(linePreTaxPaise, componentLines);
        taxPaise = addPaise(taxPaise, lineTax.totalPaise);
        quoteLines.push({
          productId: product._id,
          productVersion: product.version ?? 1,
          name: product.name,
          sku: product.sku ?? "",
          quantity: line.quantity,
          unitPricePaise: unitPreTaxPaise,
          lineTotalPaise: linePreTaxPaise,
          pricingSnapshot: {
            stockPolicy: availability.stockPolicy,
            estimate,
            hsnSac,
            componentTax: lineTax,
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
        });
        if (availability.stockPolicy === EcommerceStockPolicy.QUANTITY_TRACKED) {
          reserveLines.push({ productId: product._id, quantity: line.quantity });
        }
      }

      const expiresAt = new Date(Date.now() + QUOTE_TTL_MS);
      const quoteId = createId("equote");

      await reserveStockForQuote({
        tenantId: req.auth.tenantId,
        quoteId,
        lines: reserveLines,
        expiresAt,
        session,
      });

      const totalPaise = addPaise(
        addPaise(subtotalPaise, taxPaise),
        fulfilmentChargePaise,
      );

      const financialSnapshot = {
        subtotalPaise,
        taxPaise,
        fulfilmentChargePaise,
        totalPaise,
        taxComponentLines: componentLines,
        supplyCase,
        destinationState,
        placeOfSupplyState: destinationState,
        catalogTaxSettingsVersion: taxSettings?.version ?? 1,
        fulfilmentSettingsVersion: fulfilmentRow?.version ?? 1,
        taxPresentation: EcommerceCheckoutTaxPresentation.ACCOUNTANT_COMPONENT_APPROVED,
        pickupBranchId,
        quotedAt: new Date().toISOString(),
        paymentMethod,
        codPincodeSnapshot,
      };

      const row = (
        await EcommercePriceQuote.create(
          [
            {
              _id: quoteId,
              tenantId: req.auth.tenantId,
              customerId: req.auth.id,
              status: EcommerceQuoteStatus.ACTIVE,
              lines: quoteLines,
              fulfilmentMode: mode,
              pickupBranchId,
              addressSnapshot,
              fulfilmentChargePaise,
              financialSnapshot,
              subtotalPaise,
              taxPaise,
              totalPaise,
              taxConfigVersion: fulfilmentRow?.version ?? 1,
              paymentMethod,
              codPincodeSnapshot,
              expiresAt,
              idempotencyKey,
              creationBodyHash: bodyHash,
              ...(opts.assistedByUserId ? { assistedByUserId: opts.assistedByUserId } : {}),
            },
          ],
          { session },
        )
      )[0];

      const methodOptions = derivePaymentMethodOptions({ capability, codEvaluation });
      return { quote: mapQuote(row.toObject(), capability, methodOptions), created: true };
    });
  } catch (err) {
    if (err?.code === 11000 && /idempotencyKey/.test(String(err.message))) {
      let row = await EcommercePriceQuote.findOne({
        tenantId: req.auth.tenantId,
        customerId: req.auth.id,
        idempotencyKey,
      }).lean();
      if (row) {
        if (row.creationBodyHash && row.creationBodyHash !== bodyHash) {
          throw errors.conflict(
            "IDEMPOTENCY_KEY_REUSED",
            "This idempotency key was already used with a different request.",
          );
        }
        if (row.status === EcommerceQuoteStatus.ACTIVE && new Date(row.expiresAt) <= new Date()) {
          await withTransaction(async (session) => {
            row = await expireQuoteByTimeIfActive(row, session);
          });
          row = await EcommercePriceQuote.findById(row._id).lean();
        }
        const cap = await loadCheckoutCapability(req.auth.tenantId, req.tenant);
        const tenantReplay = await tenantForEcommerceCheckout(req.auth.tenantId, req.tenant);
        const fulfilmentReplay = await EcommerceFulfilmentSettings.findOne({
          tenantId: req.auth.tenantId,
        }).lean();
        const taxReplay = await loadTaxSettings(req.auth.tenantId);
        const codReplay = evaluateCodEligibility({
          tenant: tenantReplay,
          taxSettings: taxReplay,
          fulfilmentSettingsRow: fulfilmentReplay ?? {},
          fulfilmentMode: row.fulfilmentMode,
          addressSnapshot: row.addressSnapshot,
        });
        const methodOptions = derivePaymentMethodOptions({ capability: cap, codEvaluation: codReplay });
        return { quote: mapQuote(row, cap, methodOptions), created: false };
      }
    }
    throw err;
  }
}

export async function getCustomerQuote(req) {
  assertEcommerceOperational(req.tenant);
  let row = await EcommercePriceQuote.findOne({
    _id: req.params.quoteId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  if (!row) throw errors.notFound("Quote");
  if (row.status === EcommerceQuoteStatus.ACTIVE && new Date(row.expiresAt) <= new Date()) {
    await withTransaction(async (session) => {
      row = await expireQuoteByTimeIfActive(row, session);
    });
    row = await EcommercePriceQuote.findById(row._id).lean();
  }
  const tenant = await tenantForEcommerceCheckout(req.auth.tenantId, req.tenant);
  const capability = await loadCheckoutCapability(req.auth.tenantId, tenant);
  logQuoteCapabilityDebug(req, { quoteRow: row, tenant, capability });
  const fulfilmentRow = await EcommerceFulfilmentSettings.findOne({ tenantId: req.auth.tenantId }).lean();
  const taxSettings = await EcommerceTaxSettings.findOne({ tenantId: req.auth.tenantId }).lean();
  const codEvaluation = evaluateCodEligibility({
    tenant,
    taxSettings,
    fulfilmentSettingsRow: fulfilmentRow ?? {},
    fulfilmentMode: row.fulfilmentMode,
    addressSnapshot: row.addressSnapshot,
  });
  const methodOptions = derivePaymentMethodOptions({ capability, codEvaluation });
  return {
    ...mapQuote(row, capability, methodOptions),
    schemePurchasePreviewEnabled: (row.paymentMethod ?? EcommercePaymentMethod.ONLINE) === EcommercePaymentMethod.ONLINE
      && (fulfilmentRow?.schemeCheckoutEnabled === true
        || Boolean(await customerHasOnlineSchemeAllocation({ tenantId: req.auth.tenantId, customerId: req.auth.id }))),
  };
}

export async function cancelCustomerQuote(req) {
  assertEcommerceOperational(req.tenant);
  const capability = await loadCheckoutCapability(req.auth.tenantId, req.tenant);
  return withTransaction(async (session) => {
    const cancelled = await cancelActiveQuoteRow(
      req.params.quoteId,
      req.auth.tenantId,
      req.auth.id,
      session,
    );
    if (!cancelled) {
      const row = await EcommercePriceQuote.findOne({
        _id: req.params.quoteId,
        tenantId: req.auth.tenantId,
        customerId: req.auth.id,
      }).session(session);
      if (!row) throw errors.notFound("Quote");
      throw errors.business("QUOTE_NOT_ACTIVE", "Quote cannot be cancelled.", { status: row.status });
    }
    return mapQuote(cancelled.toObject(), capability);
  });
}

export async function getSchemePurchasePreview(req, { session } = {}) {
  assertEcommerceOperational(req.tenant);
  const { tenantId, id: customerId } = req.auth;
  const { quoteId } = req.params;
  const { schemeId, basis } = req.query;
  const read = (query) => session ? query.session(session) : query;
  const store = await read(EcommerceFulfilmentSettings.findOne({ tenantId }).select("schemeCheckoutEnabled")).lean();
  const quote = await read(EcommercePriceQuote.findOne({ _id: quoteId, tenantId, customerId })).lean();
  const scheme = await read(Scheme.findOne({ _id: schemeId, tenantId, customerId })).lean();
  if (!quote || !scheme) throw errors.notFound("Scheme or checkout quote");
  // The switch decides which schemes may START being used online. A scheme whose value is already
  // allocated to online orders can only be spent online, so it stays spendable here.
  if (store?.schemeCheckoutEnabled !== true
    && !(await schemeHasOnlineAllocation({ tenantId, schemeId, session }))) {
    throw errors.business("SCHEME_CHECKOUT_DISABLED", "This jeweller has disabled scheme checkout previews.");
  }
  if (quote.status !== EcommerceQuoteStatus.ACTIVE || new Date(quote.expiresAt) <= new Date()) {
    throw errors.business("QUOTE_NOT_AVAILABLE", "Refresh the checkout quote before previewing scheme savings.");
  }
  if (quote.paymentMethod === EcommercePaymentMethod.COD) {
    throw errors.business("SCHEME_CHECKOUT_COD", "Scheme checkout requires an online payment quote.");
  }
  const rules = scheme.planSnapshot?.schemePurchaseRules;
  if (!["ONLINE", "BOTH"].includes(rules?.channel) || !rules.settlementBases.includes(basis) ||
      !scheme.planSnapshot?.redemptionRules?.allowedModes?.includes(RedemptionMode.PURCHASE_ADJUSTMENT)) {
    throw errors.business("SCHEME_PURCHASE_NOT_ALLOWED", "The enrolled plan does not allow online purchase adjustment on this basis.");
  }
  if (quote.pickupBranchId && quote.pickupBranchId !== scheme.branchId &&
      !scheme.planSnapshot.redemptionRules.redeemAtAnyBranch) {
    throw errors.business("SCHEME_PICKUP_BRANCH_NOT_ALLOWED", "Select the scheme branch for pickup.");
  }
  await assertRedemptionKyc(req, customerId, { session });
  if (await read(Redemption.exists({ tenantId, schemeId, status: { $in: OPEN_REDEMPTION_STATUSES } }))) {
    throw errors.business("REDEMPTION_ALREADY_OPEN", "A redemption request is already in progress.");
  }
  const settlement = await settlementPreview({
    ...req, params: { schemeId }, body: { mode: RedemptionMode.PURCHASE_ADJUSTMENT },
  }, ClosureType.MATURITY_REDEMPTION);
  if (!settlement.eligible) throw errors.business(
    settlement.blockers[0]?.code ?? "SCHEME_INELIGIBLE",
    settlement.blockers[0]?.message ?? "This scheme is not eligible for purchase adjustment.",
  );

  const products = await read(EcommerceProduct.find({
    tenantId, _id: { $in: quote.lines.map((line) => line.productId) }, status: EcommerceProductStatus.PUBLISHED,
  }).select("schemePurchasePolicy categoryId version")).lean();
  const categories = await read(EcommerceCategory.find({
    tenantId, _id: { $in: products.flatMap((product) => product.categoryId ?? []) }, active: true,
  }).select("schemePurchaseAllowed")).lean();
  const categoryById = new Map(categories.map((category) => [category._id, category]));
  const versions = new Map(quote.lines.map((line) => [line.productId, line.productVersion]));
  const eligibleProductIds = new Set(products.filter((product) => {
    const category = categoryById.get(product.categoryId);
    if (product.categoryId && !category || (product.version ?? 1) !== versions.get(product._id)) return false;
    return product.schemePurchasePolicy === "ALLOW" ||
      (product.schemePurchasePolicy !== "DISALLOW" && category?.schemePurchaseAllowed === true);
  }).map((product) => product._id));
  const balance = basis === "GOLD_WEIGHT"
    ? (settlement.goldWeightMg ?? 0) + (settlement.benefitWeightMg ?? 0)
    : settlement.settlementPaise;
  const available = await getSchemePurchaseEntitlement({ tenantId, schemeId, balance, basis,
    waiverCapPaise: rules.waiverCapPaise, session });
  return {
    quoteId, schemeId, expiresAt: quote.expiresAt, schemeVersion: scheme.version, branchId: scheme.branchId, availableBalance: balance, waiverCapPaise: rules.waiverCapPaise,
    usedBenefitUnits: available.usedBenefitUnits, valuationRateEffectiveDate: settlement.valuationRateEffectiveDate || undefined,
    benefitPaise: settlement.benefitPaise ?? 0,
    benefitWeightMg: settlement.benefitWeightMg ?? 0,
    ...previewSchemePurchase({ quote, eligibleProductIds, basis, balance: available.balance,
      rules: { ...rules, waiverCapPaise: available.waiverCapPaise } }),
  };
}
