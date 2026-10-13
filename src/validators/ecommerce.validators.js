import { z } from "zod";
import * as E from "../constants/enums.js";
import { cursorQuery } from "./common.validators.js";

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
    codEnabled: z.boolean().optional(),
    codPincodes: z.array(z.string().trim().min(4).max(12)).max(5000).optional(),
    codAcceptanceWindowMinutes: z.number().int().min(30).max(2880).optional(),
    requireCourierTrackingForShipped: z.boolean().optional(),
    storePolicies: z
      .object({
        version: z.number().int().min(0).optional(),
        publishedAt: z.string().datetime().optional(),
        shippingPolicyText: z.string().trim().max(8000).optional(),
        shippingPolicyApprovedAt: z.string().datetime().optional(),
        returnsPolicyText: z.string().trim().max(8000).optional(),
        returnsPolicyApprovedAt: z.string().datetime().optional(),
        cancellationPolicyText: z.string().trim().max(8000).optional(),
        cancellationPolicyApprovedAt: z.string().datetime().optional(),
        refundContactPolicyText: z.string().trim().max(4000).optional(),
        refundContactPolicyApprovedAt: z.string().datetime().optional(),
        returnEligibilityDays: z.number().int().min(0).max(365).optional(),
        returnExcludedCategoryIds: z.array(z.string().trim().min(4).max(80)).max(200).optional(),
      })
      .optional(),
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
    paymentMethod: enumSchema(E.EcommercePaymentMethod).optional(),
  })
  .strict();

export const ecommerceCodOrderActionBody = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const ecommerceCourierCodCollectionBody = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    reference: z.string().trim().min(2).max(160),
    evidenceNote: z.string().trim().max(500).optional(),
    providerId: z.string().trim().min(1).max(64).optional(),
    trackingReference: z.string().trim().max(120).optional(),
  })
  .strict();

export const ecommerceCodRemittanceBatchCreateBody = z
  .object({
    providerId: z.string().trim().min(1).max(64).optional(),
    statementReference: z.string().trim().min(2).max(160),
  })
  .strict();

export const ecommerceCodRemittanceLineBody = z
  .object({
    grossPaise: z.number().int().min(1),
    feePaise: z.number().int().min(0).optional(),
  })
  .strict();

export const ecommerceCodRemittanceReconcileBody = z
  .object({
    bankCreditReference: z.string().trim().min(2).max(160),
    bankCreditPaise: z.number().int().min(0),
    bankCreditedAt: z.string().datetime().optional(),
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

export const ecommerceTestHarnessPaymentBody = z
  .object({
    outcome: z.enum(["COMPLETED", "FAILED"]).optional(),
    paymentAttemptId: z.string().trim().min(4).max(80).optional(),
  })
  .strict();

export const ecommerceOrderFulfilmentTransitionBody = z
  .object({
    targetStatus: enumSchema(E.EcommerceOrderStatus),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export const ecommerceCancellationReasonBody = z
  .object({
    reason: z.string().trim().min(8).max(2000).optional(),
  })
  .strict();

export const ecommerceCancellationDecisionBody = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]),
    decisionReason: z.string().trim().max(2000).optional(),
    expectedVersion: z.number().int().nonnegative(),
    stockDisposition: enumSchema(E.EcommerceCancellationStockDisposition).optional(),
  })
  .strict();

export const ecommerceAdminInitiateCancellationBody = z
  .object({
    reason: z.string().trim().min(8).max(2000),
    expectedVersion: z.number().int().nonnegative(),
    stockDisposition: enumSchema(E.EcommerceCancellationStockDisposition).optional(),
  })
  .strict();

export const ecommerceCodCancellationManualRefundBody = z
  .object({
    amountPaise: z.number().int().min(1),
    recipient: z.string().trim().min(2).max(200),
    method: z.string().trim().min(2).max(64),
    reference: z.string().trim().min(2).max(120),
    proofNote: z.string().trim().min(8).max(500),
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

export const ecommerceOrderDeliveryTrackingPatchBody = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    carrierName: z.string().trim().max(120).optional(),
    trackingNumber: z.string().trim().max(80).optional(),
    trackingUrl: z.string().trim().max(500).optional(),
    dispatchedAt: z.string().datetime().optional(),
    deliveredAt: z.string().datetime().optional(),
  })
  .strict();

export const ecommerceReturnRequestCreateBody = z
  .object({
    reason: z.string().trim().min(8).max(2000),
    kind: enumSchema(E.EcommerceOrderReturnKind).optional(),
    evidenceNote: z.string().trim().max(1000).optional(),
  })
  .strict();

export const ecommerceReturnDecisionBody = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]),
    decisionReason: z.string().trim().max(2000).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export const ecommerceReturnReceivedBody = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    receiptNote: z.string().trim().max(2000).optional(),
  })
  .strict();

export const ecommerceReturnInspectionBody = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    inspectionNote: z.string().trim().min(4).max(2000),
    inspectionOutcome: enumSchema(E.EcommerceOrderReturnInspectionOutcome),
    confirmRestockInventory: z.boolean().optional(),
  })
  .strict();

export const ecommerceReturnRefundCaseBody = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export const ecommerceReturnManualRefundBody = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    amountPaise: z.number().int().min(1),
    recipient: z.string().trim().min(2).max(200),
    method: z.string().trim().min(2).max(64),
    reference: z.string().trim().min(2).max(120),
    proofNote: z.string().trim().min(8).max(500),
  })
  .strict();

export const ecommerceReturnResolveBody = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    resolutionNote: z.string().trim().min(8).max(2000),
    replacementOrderId: z.string().trim().min(4).max(80).optional(),
    manualSettlementNote: z.string().trim().max(2000).optional(),
  })
  .strict();

export const ecommerceAdminOrdersListQuery = cursorQuery.extend({
  status: z.string().trim().max(40).optional(),
  paymentMethod: z.string().trim().max(16).optional(),
  fulfilmentMode: z.string().trim().max(32).optional(),
  createdFrom: z.string().trim().max(32).optional(),
  createdTo: z.string().trim().max(32).optional(),
  paymentException: z.enum(["true", "false"]).optional(),
  codPendingAcceptance: z.enum(["true"]).optional(),
  cancellationPending: z.enum(["true"]).optional(),
  returnPending: z.enum(["true"]).optional(),
  collected: z.enum(["true", "false"]).optional(),
});

export const ecommerceSummaryQuery = z
  .object({
    from: z.string().trim().max(32).optional(),
    to: z.string().trim().max(32).optional(),
    period: z.string().trim().max(32).optional(),
  })
  .passthrough();

export const ecommercePickupConfirmBody = z
  .object({
    code: z.string().trim().regex(/^\d{6}$/),
    recipientName: z.string().trim().min(2).max(120).optional(),
  })
  .strict();

export const ecommerceDeliveryHandoverBody = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    proofReference: z.string().trim().min(4).max(160),
    recipientName: z.string().trim().min(2).max(120),
  })
  .strict();

export const ecommerceReportKeyParam = z.object({
  reportKey: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .transform((value) => value.toUpperCase().replace(/-/g, "_"))
    .pipe(
      z.enum([
        "ECOMMERCE_SALES",
        "ECOMMERCE_ORDERS_FULFILMENT",
        "ECOMMERCE_PRODUCTS",
      ]),
    ),
});
