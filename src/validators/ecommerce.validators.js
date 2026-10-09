import { z } from "zod";
import * as E from "../constants/enums.js";

const enumSchema = (enumeration) => z.enum(Object.values(enumeration));

const makingChargeBody = z
  .object({
    fixedPaise: z.number().int().min(0).optional(),
    perGramPaise: z.number().int().min(0).optional(),
    percentBps: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .optional();

const offerBody = z
  .object({
    type: enumSchema(E.EcommerceOfferType),
    valuePaise: z.number().int().min(0).optional(),
    percentBps: z.number().int().min(0).max(10_000).optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
  })
  .strict()
  .optional()
  .nullable();

const fixedPricingBody = z
  .object({
    basePricePaise: z.number().int().min(0),
    salePricePaise: z.number().int().min(0).optional(),
    saleStartsAt: z.string().datetime().optional(),
    saleEndsAt: z.string().datetime().optional(),
  })
  .strict()
  .optional();

const stoneLineBody = z.object({
  name: z.string().trim().max(120).optional(),
  chargePaise: z.number().int().min(0),
});

export const ecommerceCategoryCreateBody = z
  .object({
    name: z.string().trim().min(1).max(160),
    slug: z.string().trim().max(120).optional(),
    description: z.string().max(4000).optional(),
    imageUploadId: z.string().optional(),
    displayOrder: z.number().int().optional(),
    active: z.boolean().optional(),
  })
  .strict();

export const ecommerceCategoryPatchBody = ecommerceCategoryCreateBody.partial().extend({
  expectedVersion: z.number().int().positive(),
});

export const ecommerceProductCreateBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: z.string().trim().max(120).optional(),
    sku: z.string().trim().max(64).optional(),
    description: z.string().max(8000).optional(),
    categoryId: z.string().optional().nullable(),
    imageUploadIds: z.array(z.string()).max(12).optional(),
    featured: z.boolean().optional(),
    purity: enumSchema(E.EcommerceGoldPurity).optional(),
    goldWeightMg: z.number().int().min(0).optional(),
    makingChargeMode: enumSchema(E.EcommerceMakingChargeMode).optional(),
    makingCharge: makingChargeBody,
    stones: z.array(stoneLineBody).max(20).optional(),
    stoneChargePaise: z.number().int().min(0).optional(),
    otherChargesPaise: z.number().int().min(0).optional(),
    priceMode: enumSchema(E.EcommercePriceMode),
    fixedPricing: fixedPricingBody,
    offer: offerBody,
    taxClassification: z.string().trim().max(64).optional(),
  })
  .strict();

export const ecommerceProductPatchBody = ecommerceProductCreateBody.partial().extend({
  expectedVersion: z.number().int().positive(),
  status: enumSchema(E.EcommerceProductStatus).optional(),
});

export const ecommerceVersionBody = z
  .object({
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const ecommerceGoldRateBody = z
  .object({
    purity: enumSchema(E.EcommerceGoldPurity),
    ratePerGramPaise: z.number().int().min(1),
    effectiveAt: z.string().datetime(),
  })
  .strict();

const taxRateLine = z.object({
  code: z.string().trim().min(1).max(32),
  label: z.string().trim().max(120).optional(),
  rateBps: z.number().int().min(0).max(10_000),
  active: z.boolean().optional(),
});

const hsnSacMappingLine = z
  .object({
    classification: z.string().trim().min(1).max(64),
    hsnSacCode: z.string().trim().min(4).max(8),
    hsnSacType: enumSchema(E.EcommerceHsnSacType),
  })
  .strict();

export const ecommerceTaxSettingsBody = z
  .object({
    expectedVersion: z.number().int().positive().optional(),
    defaultClassification: z.string().trim().max(64).optional().nullable(),
    rates: z.array(taxRateLine).max(20),
    hsnSacMappings: z.array(hsnSacMappingLine).max(40).optional(),
  })
  .strict();

export const ecommerceAddressCreateBody = z
  .object({
    label: z.string().trim().max(80).optional(),
    recipientName: z.string().trim().max(120).optional(),
    mobile: z.string().trim().max(16).optional(),
    line1: z.string().trim().min(2).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(2).max(80),
    state: z.string().trim().min(2).max(80),
    pincode: z.string().trim().min(4).max(12),
    isDefault: z.boolean().optional(),
  })
  .strict();

export const ecommerceAddressPatchBody = ecommerceAddressCreateBody
  .partial()
  .extend({ expectedVersion: z.number().int().min(0) })
  .strict();

export const ecommerceCartPutBody = z
  .object({
    expectedVersion: z.number().int().min(0).optional(),
    lines: z
      .array(
        z.object({
          productId: z.string().trim().min(4).max(80),
          quantity: z.number().int().min(1).max(99),
        }),
      )
      .max(50),
  })
  .strict();

const checkoutTaxComponentLine = z
  .object({
    componentKey: z.string().trim().min(1).max(32),
    label: z.string().trim().min(1).max(120),
    rateBps: z.number().int().min(0).max(10_000),
  })
  .strict();

export const ecommerceInventoryPatchBody = z
  .object({
    expectedVersion: z.number().int().min(0).optional(),
    stockPolicy: enumSchema(E.EcommerceStockPolicy),
    quantityOnHand: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export const ecommerceInventoryAdjustBody = z
  .object({
    expectedVersion: z.number().int().min(0),
    deltaQuantity: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, {
      message: "deltaQuantity must be non-zero",
    }),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

const checkoutTaxComponentRule = z
  .object({
    supplyCase: enumSchema(E.EcommerceTaxSupplyCase),
    componentLines: z.array(checkoutTaxComponentLine).max(20),
  })
  .strict();

export const ecommerceFulfilmentSettingsPutBody = z
  .object({
    expectedVersion: z.number().int().min(0),
    pickupEnabled: z.boolean().optional(),
    pickupBranchIds: z.array(z.string().trim().min(4).max(80)).max(50).optional(),
    deliveryEnabled: z.boolean().optional(),
    deliveryChargePaise: z.number().int().min(0).max(10_000_000).optional(),
    serviceablePincodes: z.array(z.string().trim().min(4).max(12)).max(5000).optional(),
    maxCartLines: z.number().int().min(1).max(100).optional(),
    maxQuantityPerLine: z.number().int().min(1).max(99).optional(),
    pendingPaymentWindowMinutes: z.number().int().min(5).max(120).optional(),
    checkoutTaxConfig: z
      .object({
        presentation: enumSchema(E.EcommerceCheckoutTaxPresentation).optional(),
        sellerLegalName: z.string().trim().max(200).optional(),
        sellerGstin: z.string().trim().max(15).optional(),
        registeredState: z.string().trim().max(80).optional(),
        defaultPlaceOfSupplyState: z.string().trim().max(80).optional(),
        defaultItemTaxClassification: z.string().trim().max(64).optional(),
        accountantSignOffReference: z.string().trim().max(120).optional(),
        accountantApprovedAt: z.string().datetime().optional(),
        componentLines: z.array(checkoutTaxComponentLine).max(20).optional(),
        componentRules: z.array(checkoutTaxComponentRule).max(10).optional(),
        supportedDestinationStates: z.array(z.string().trim().min(2).max(80)).max(40).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ecommerceQuoteCreateBody = z
  .object({
    fulfilmentMode: enumSchema(E.EcommerceFulfilmentMode),
    pickupBranchId: z.string().trim().min(4).max(80).optional(),
    pincode: z.string().trim().min(4).max(12).optional(),
    addressId: z.string().trim().min(4).max(80).optional(),
  })
  .strict();

export const ecommerceOrderCreateBody = z
  .object({
    quoteId: z.string().trim().min(4).max(80),
  })
  .strict();

export const ecommercePaymentIntentBody = z
  .object({
    redirectUrl: z.string().url(),
  })
  .strict();

export const ecommerceOrderFulfilmentTransitionBody = z
  .object({
    targetStatus: enumSchema(E.EcommerceOrderStatus),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export const ecommercePaymentExceptionRefundManualBody = z
  .object({
    providerRefundReference: z.string().trim().min(4).max(120),
    reason: z.string().trim().min(8).max(500),
    evidenceNote: z.string().trim().min(8).max(2000),
  })
  .strict();

export const ecommercePaymentReconcileRetryBody = z
  .object({
    reason: z.string().trim().min(8).max(500),
  })
  .strict();

export const ecommercePaymentOperationalAckBody = z
  .object({
    resolution: z.enum(["CONTINUE_AWAITING", "ESCALATE_REVIEW"]),
    reason: z.string().trim().min(8).max(500),
    evidenceNote: z.string().trim().min(8).max(2000),
  })
  .strict();
