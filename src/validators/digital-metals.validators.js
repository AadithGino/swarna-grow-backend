import { z } from "zod";

const metalEnum = z.enum(["GOLD", "SILVER"]);
const finenessPpm = z.number().int().min(1).max(999_999);

const feeRuleBody = z.object({
  type: z.enum(["NONE", "FLAT_INR", "PERCENT"]),
  amountPaise: z.number().int().min(0).optional(),
  percent: z.number().min(0).max(100).optional(),
  minPaise: z.number().int().min(0).optional(),
  maxPaise: z.number().int().min(0).nullable().optional(),
});

const taxLineBody = z.object({
  code: z.string().trim().min(1).max(32),
  label: z.string().trim().max(120).optional(),
  base: z.enum(["METAL_SUBTOTAL", "FEE", "MINTING", "DELIVERY", "TOTAL_EXGST"]).optional(),
  ratePercent: z.number().min(0).max(100),
  active: z.boolean().optional(),
});

export const digitalMetalsSettingsPatchBody = z
  .object({
    expectedVersion: z.number().int().positive(),
    metal: metalEnum,
    finenessPpm,
    buyFee: feeRuleBody.optional(),
    sellFee: feeRuleBody.optional(),
    taxLines: z.array(taxLineBody).max(20).optional(),
    quoteTtlSeconds: z.number().int().min(60).max(86_400).optional(),
    sellQuoteTtlSeconds: z.number().int().min(60).max(86_400).optional(),
    sellApprovalTtlSeconds: z.number().int().min(60).max(86_400).optional(),
    rateMaxAgeSeconds: z.number().int().min(60).max(86_400).optional(),
    holdingPeriodDays: z.number().int().min(0).max(3650).optional(),
    exposureCapPaise: z.any().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.exposureCapPaise !== undefined && body.exposureCapPaise !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["exposureCapPaise"],
        message: "Exposure cap is not enforced in this release and cannot be enabled.",
      });
    }
  });

export const digitalMetalsRatePublishBody = z
  .object({
    metal: metalEnum,
    finenessPpm,
    customerBuyRatePerGramPaise: z.number().int().min(1).max(100_000_000),
    customerSellRatePerGramPaise: z.number().int().min(1).max(100_000_000),
    effectiveAt: z.string().datetime().optional(),
    effectiveAtLocal: z.string().optional(),
    expectedSequence: z.number().int().positive().optional(),
  })
  .strict();

export const digitalMetalsQuotePreviewBody = z
  .object({
    side: z.enum(["BUY", "SELL"]),
    metal: metalEnum,
    finenessPpm,
    inputMode: z.enum(["BUDGET_INR", "QUANTITY_UG"]).optional(),
    budgetPaise: z.number().int().positive().optional(),
    quantityUg: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.side === "BUY") {
      if (!body.inputMode) {
        ctx.addIssue({ code: "custom", message: "inputMode is required for buy quotes." });
        return;
      }
      if (body.inputMode === "BUDGET_INR" && body.budgetPaise == null) {
        ctx.addIssue({ code: "custom", message: "budgetPaise is required for BUDGET_INR." });
      }
      if (body.inputMode === "QUANTITY_UG" && body.quantityUg == null) {
        ctx.addIssue({ code: "custom", message: "quantityUg is required for QUANTITY_UG." });
      }
    } else if (body.quantityUg == null) {
      ctx.addIssue({ code: "custom", message: "quantityUg is required for sell quotes." });
    }
  });

export const digitalMetalsTenantPauseBody = z
  .object({
    pause: z.boolean(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict();

export const platformDigitalMetalsTermsBody = z
  .object({
    termsVersion: z.string().trim().min(1).max(64),
    contentSnapshot: z.string().trim().min(32).max(65_536),
    contentRef: z.string().trim().max(512).optional(),
  })
  .strict();

export const digitalMetalsCustomerBuyQuoteBody = z
  .object({
    metal: z.enum(["GOLD", "SILVER"]),
    finenessPpm: z.number().int().min(1).max(999_999),
    inputMode: z.enum(["BUDGET_INR", "QUANTITY_UG"]),
    budgetPaise: z.number().int().positive().optional(),
    quantityUg: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.inputMode === "BUDGET_INR" && body.budgetPaise == null) {
      ctx.addIssue({ code: "custom", message: "budgetPaise is required for BUDGET_INR." });
    }
    if (body.inputMode === "QUANTITY_UG" && body.quantityUg == null) {
      ctx.addIssue({ code: "custom", message: "quantityUg is required for QUANTITY_UG." });
    }
  });

export const digitalMetalsBuyOrderCreateBody = z
  .object({
    quoteId: z.string().trim().min(1),
    termsVersionAccepted: z.string().trim().min(1).max(64),
    termsContentHashAccepted: z.string().trim().min(32).max(128),
  })
  .strict();

export const digitalMetalsBuyPaymentIntentBody = z
  .object({
    redirectUrl: z.string().trim().url().max(2048),
  })
  .strict();

export const platformDigitalMetalsTaxApproveBody = z
  .object({
    approve: z.boolean(),
  })
  .strict();

export const digitalMetalsCustomerSellQuoteBody = z
  .object({
    metal: z.enum(["GOLD", "SILVER"]),
    finenessPpm: z.number().int().min(1).max(999_999),
    quantityUg: z.number().int().positive(),
  })
  .strict();

export const digitalMetalsSellOrderCreateBody = z
  .object({
    quoteId: z.string().trim().min(1),
    termsVersionAccepted: z.string().trim().min(1).max(64),
    termsContentHashAccepted: z.string().trim().min(32).max(128),
  })
  .strict();

export const digitalMetalsSellOrderConfirmBody = z
  .object({
    bankDestinationId: z.string().trim().min(1),
  })
  .strict();

export const digitalMetalsSellApproveBody = z
  .object({
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();

export const digitalMetalsBankDestinationCreateBody = z
  .object({
    accountHolderName: z.string().trim().min(2).max(120),
    accountNumber: z.string().trim().min(4).max(18),
    ifsc: z.string().trim().min(11).max(11),
    bankName: z.string().trim().max(120).optional(),
  })
  .strict();

export const digitalMetalsBankDestinationPatchBody = z
  .object({
    accountHolderName: z.string().trim().min(2).max(120).optional(),
    accountNumber: z.string().trim().min(4).max(18).optional(),
    confirmAccountNumber: z.string().trim().min(4).max(18).optional(),
    ifsc: z.string().trim().min(11).max(11).optional(),
    bankName: z.string().trim().max(120).optional(),
  })
  .strict();

export const digitalMetalsPayoutCreateBody = z
  .object({
    payableId: z.string().trim().min(1),
    amountPaise: z.number().int().positive().optional(),
    evidenceUploadIds: z.array(z.string().trim().min(1)).max(10).optional(),
  })
  .strict();

export const digitalMetalsPayoutSubmitBody = z
  .object({
    bankReference: z.string().trim().min(1).max(128),
  })
  .strict();

export const digitalMetalsPayoutFailureBody = z
  .object({
    reason: z.string().trim().min(3).max(500),
    evidenceUploadIds: z.array(z.string().trim().min(1)).min(1).max(10),
  })
  .strict();

export const digitalMetalsPayoutResolveUnknownBody = z
  .object({
    outcome: z.enum(["FAILED", "SETTLED"]),
    resolutionNote: z.string().trim().min(3).max(2000),
    evidenceUploadIds: z.array(z.string().trim().min(1)).min(1).max(10),
    settlementDate: z.string().trim().min(8).max(32).optional(),
    bankReference: z.string().trim().min(1).max(128).optional(),
    approverAttestation: z.boolean().optional(),
  })
  .strict();

export const digitalMetalsPayoutSettlementBody = z
  .object({
    settlementDate: z.string().trim().min(8).max(32),
    bankReference: z.string().trim().min(1).max(128),
    evidenceUploadIds: z.array(z.string().trim().min(1)).min(1).max(10),
    approverAttestation: z.boolean(),
    settlementIdempotencyKey: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.approverAttestation !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["approverAttestation"],
        message: "Approver attestation must be true.",
      });
    }
  });

export const digitalMetalsRiskHoldCreateBody = z
  .object({
    customerId: z.string().trim().min(1).optional(),
    reasonCode: z.enum(["CHARGEBACK", "REFUND_EXPOSURE", "MANUAL"]),
    exposurePaise: z.number().int().min(0),
    unrecoverableMetalUg: z.number().int().min(0).optional(),
    relatedBuyOrderId: z.string().trim().optional(),
    relatedRefundCaseId: z.string().trim().optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

export const digitalMetalsRiskHoldResolveBody = z
  .object({
    resolutionNote: z.string().trim().min(3).max(2000),
  })
  .strict();

export const digitalMetalsRedemptionCatalogCreateBody = z
  .object({
    sku: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(160),
    metal: z.enum(["GOLD", "SILVER"]),
    finenessPpm: z.number().int().positive(),
    unitQuantityUg: z.number().int().positive(),
    mintingRule: z.record(z.unknown()).optional(),
    mintingPercentBase: z.enum(["FIXED_DENOMINATION", "METAL_VALUE_AT_BUY_RATE"]).optional(),
    deliveryFlatPaise: z.number().int().min(0).optional(),
    deliveryWaiveAboveTotalChargePaise: z.number().int().min(0).nullable().optional(),
    packagingPaise: z.number().int().min(0).optional(),
    taxLines: z.array(z.record(z.unknown())).optional(),
    leadTimeDays: z.number().int().min(0).max(365).optional(),
    pickupEnabled: z.boolean().optional(),
    deliveryEnabled: z.boolean().optional(),
    active: z.boolean().optional(),
    imageUploadIds: z.array(z.string()).optional(),
  })
  .strict();

export const digitalMetalsRedemptionQuoteBody = z
  .object({
    catalogueItemId: z.string().trim().min(1),
    metal: z.enum(["GOLD", "SILVER"]),
    finenessPpm: z.number().int().positive(),
    unitCount: z.number().int().positive(),
    fulfilmentMode: z.enum(["PICKUP", "DELIVERY"]),
    pickupBranchId: z.string().trim().optional(),
    deliveryAddressId: z.string().trim().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.fulfilmentMode === "PICKUP") {
      if (!String(body.pickupBranchId ?? "").trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Pickup branch is required.",
          path: ["pickupBranchId"],
        });
      }
    }
    if (body.fulfilmentMode === "DELIVERY") {
      if (!String(body.deliveryAddressId ?? "").trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Delivery address is required.",
          path: ["deliveryAddressId"],
        });
      }
    }
  });

export const digitalMetalsRedemptionOrderCreateBody = z
  .object({
    quoteId: z.string().trim().min(1),
    termsVersionAccepted: z.string().trim().min(1),
    termsContentHashAccepted: z.string().trim().min(64).max(128),
  })
  .strict();

export const digitalMetalsRedemptionPaymentIntentBody = z
  .object({
    redirectUrl: z.string().trim().url().max(2048),
  })
  .strict();

export const digitalMetalsRedemptionFulfilmentVersionBody = z
  .object({
    expectedVersion: z.number().int().positive(),
    note: z.string().trim().max(500).optional(),
    fulfilmentBranchId: z.string().trim().optional(),
    leadTimeDays: z.number().int().min(0).max(365).optional(),
    carrier: z.string().trim().max(120).optional(),
    trackingReference: z.string().trim().max(128).optional(),
    evidenceUploadIds: z.array(z.string().trim().min(1)).max(10).optional(),
    pickupCode: z.string().trim().min(4).max(12).optional(),
    approverAttestation: z.boolean().optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const digitalMetalsRedemptionChargeRefundManualBody = z
  .object({
    resolutionNote: z.string().trim().min(3).max(2000),
    evidenceUploadIds: z.array(z.string().trim().min(1)).min(1).max(10),
  })
  .strict();

export const digitalMetalsProcurementEntryBody = z
  .object({
    entryType: z.enum(["OPENING_POSITION", "COMMITMENT", "RECEIPT", "DISPOSAL", "REVERSAL"]),
    metal: z.enum(["GOLD", "SILVER"]),
    finenessPpm: z.number().int().positive(),
    quantityUg: z.number().int().positive(),
    obligationQuantityUg: z.number().int().positive().optional(),
    amountPaise: z.number().int().min(0).optional(),
    supplierRef: z.string().trim().max(120).optional(),
    billRef: z.string().trim().max(120).optional(),
    locationCode: z.string().trim().max(32).optional(),
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    commitmentEntryId: z.string().trim().optional(),
    reversesEntryId: z.string().trim().optional(),
    evidenceUploadIds: z.array(z.string().trim().min(1)).max(10).optional(),
    reasonNote: z.string().trim().max(500).optional(),
    allowOverReceipt: z.boolean().optional(),
  })
  .strict();

export const digitalMetalsHedgeCloseDayBody = z
  .object({
    businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    revisionReason: z.string().trim().max(500).optional(),
  })
  .strict();

const documentTypeEnum = z.enum([
  "REDEMPTION_CHARGE_RECEIPT",
  "HANDOVER_RECEIPT",
  "SELL_ACKNOWLEDGEMENT",
  "PAYOUT_RECEIPT",
  "METAL_STATEMENT",
]);

export const digitalMetalsAdminScopedOrderListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().trim().min(4).max(80).optional(),
    status: z.string().trim().max(64).optional(),
    customerId: z.string().trim().min(1).optional(),
    q: z.string().trim().max(80).optional(),
  })
  .strict();

export const digitalMetalsCustomerOrderListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().trim().min(4).max(80).optional(),
    status: z.string().trim().max(64).optional(),
  })
  .strict();

export const digitalMetalsBankVerificationQueueQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().trim().min(4).max(80).optional(),
    status: z.enum(["PENDING_VERIFICATION", "ACTIVE", "DISABLED", "ALL"]).optional(),
    customerId: z.string().trim().min(1).optional(),
  })
  .strict();

export const digitalMetalsBankDestinationVerifyBody = z
  .object({
    activate: z.boolean().optional(),
    note: z.string().trim().min(3).max(2000),
    evidenceUploadIds: z.array(z.string().trim().min(1)).max(10).optional(),
  })
  .strict();

export const digitalMetalsBankDestinationDisableBody = z
  .object({
    note: z.string().trim().min(3).max(2000),
    evidenceUploadIds: z.array(z.string().trim().min(1)).max(10).optional(),
  })
  .strict();

export const digitalMetalsDocumentRequestBody = z
  .object({
    docType: documentTypeEnum,
    subjectId: z.string().trim().min(1).optional(),
    fromBusinessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toBusinessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    customerId: z.string().trim().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.docType === "METAL_STATEMENT") {
      if (!body.fromBusinessDate || !body.toBusinessDate) {
        ctx.addIssue({
          code: "custom",
          path: ["fromBusinessDate"],
          message: "Statement period required.",
        });
      }
      return;
    }
    if (!body.subjectId) {
      ctx.addIssue({
        code: "custom",
        path: ["subjectId"],
        message: "Required for this document type.",
      });
    }
  });
