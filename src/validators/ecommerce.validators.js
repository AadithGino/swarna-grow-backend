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

export const ecommerceTaxSettingsBody = z
  .object({
    expectedVersion: z.number().int().positive().optional(),
    defaultClassification: z.string().trim().max(64).optional().nullable(),
    rates: z.array(taxRateLine).max(20),
  })
  .strict();
