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
import {
  cancelActiveQuoteRow,
  expireActiveQuoteRow,
  expireQuoteByTimeIfActive,
} from "../lib/ecommerce-quote-lifecycle.js";
import { revalidateQuoteForOrder } from "../lib/ecommerce-quote-revalidation.js";
import { reserveStockForQuote } from "../lib/ecommerce-stock-reserve.js";
import { deriveEcommerceCheckoutCapability } from "../lib/ecommerce-checkout-capability.js";
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
  Tenant,
} from "../models/index.js";
import {
  EcommerceCheckoutTaxPresentation,
  EcommerceFulfilmentMode,
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
  const tenant =
    tenantLite?.integrationSecrets != null
      ? tenantLite
      : await Tenant.findById(tenantId).select("+integrationSecrets").lean();
  const fulfilmentRow = await EcommerceFulfilmentSettings.findOne({ tenantId }).lean();
  const taxSettings = await EcommerceTaxSettings.findOne({ tenantId }).lean();
  return deriveEcommerceCheckoutCapability({
    taxSettings,
    fulfilmentSettingsRow: fulfilmentRow ?? {},
    tenant: tenant ?? tenantLite,
  });
}

function mapQuote(row, capability) {
  const snap = row.financialSnapshot ?? {};
  const cap = capability ?? { paymentAllowed: false, checkoutUsable: false };
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
    paymentAllowed: cap.paymentAllowed,
    checkoutUsable: cap.checkoutUsable,
    checkoutTaxReady: cap.checkoutTaxReady ?? false,
    previewOnly: !cap.paymentAllowed,
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
  return { quote: mapQuote(row, capability), created: false };
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

export async function createCustomerQuote(req) {
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
      const { fulfilmentChargePaise } = assertFulfilmentSelection(fulfilmentSettings, {
        mode,
        pickupBranchId,
        pincode: req.body.pincode,
      });

      let addressSnapshot = null;
      if (mode === EcommerceFulfilmentMode.DELIVERY) {
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
        assertFulfilmentSelection(fulfilmentSettings, {
          mode,
          pincode: address.pincode,
        });
      }

      const cart = await EcommerceCart.findOne({
        tenantId: req.auth.tenantId,
        customerId: req.auth.id,
      }).session(session);
      const cartLines = cart?.lines ?? [];
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
        throw new AppError(
          "CHECKOUT_NOT_READY",
          "Destination state is not supported for checkout.",
          422,
          { code: "UNSUPPORTED_DESTINATION", destinationState },
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
              expiresAt,
              idempotencyKey,
              creationBodyHash: bodyHash,
            },
          ],
          { session },
        )
      )[0];

      return { quote: mapQuote(row.toObject(), capability), created: true };
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
        return { quote: mapQuote(row, cap), created: false };
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
  const capability = await loadCheckoutCapability(req.auth.tenantId, req.tenant);
  return mapQuote(row, capability);
}

export async function cancelCustomerQuote(req) {
  assertEcommerceOperational(req.tenant);
  const capability = await loadCheckoutCapability(req.auth.tenantId, req.tenant);
  return withTransaction(async (session) => {
    const cancelled = await cancelActiveQuoteRow(
      req.params.quoteId,
      req.auth.tenantId,
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
    if (cancelled.customerId !== req.auth.id) throw errors.notFound("Quote");
    return mapQuote(cancelled.toObject(), capability);
  });
}
