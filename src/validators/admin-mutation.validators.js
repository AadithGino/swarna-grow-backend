import { z } from "zod";
import * as E from "../constants/enums.js";
import { mobile, positivePaise } from "./common.validators.js";

const enumSchema = (enumeration) => z.enum(Object.values(enumeration));

const tenantAddressPatch = z
  .object({
    line1: z.string().trim().min(1).max(500).optional(),
    city: z.string().trim().min(1).max(120).optional(),
    state: z.string().trim().max(120).optional(),
    pincode: z.string().trim().max(12).optional(),
  })
  .strict();

export const tenantSettingsProfilePatchBody = z
  .object({
    expectedVersion: z.number().int().positive(),
    businessName: z.string().trim().min(2).max(160).optional(),
    displayName: z.string().trim().min(2).max(160).optional(),
    supportNumber: mobile.optional(),
    gstin: z
      .union([z.string().trim().min(5).max(20), z.literal("")])
      .optional()
      .transform((value) => (value === "" ? null : value)),
    ownerName: z.string().trim().min(2).max(120).optional(),
    ownerMobile: mobile.optional(),
    ownerEmail: z
      .union([z.string().email(), z.literal("")])
      .optional()
      .transform((value) => (value === "" ? null : value)),
    address: tenantAddressPatch.optional(),
  })
  .strict();

export const tenantSettingsBrandingPatchBody = z
  .object({
    expectedVersion: z.number().int().positive(),
    logoUploadId: z.string().min(4).max(80).optional(),
    primaryColor: z.string().trim().max(32).optional(),
    secondaryColor: z.string().trim().max(32).optional(),
    accentColor: z.string().trim().max(32).optional(),
    appDisplayName: z.string().trim().min(2).max(160).optional(),
    displayName: z.string().trim().min(2).max(160).optional(),
  })
  .strict();

export const subscriptionUpgradeRequestBody = z
  .object({
    targetTier: enumSchema(E.PlanTier).optional(),
    planTier: enumSchema(E.PlanTier).optional(),
    billingCycle: enumSchema(E.BillingCycle).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.targetTier && !value.planTier) {
      ctx.addIssue({
        code: "custom",
        path: ["targetTier"],
        message: "targetTier is required.",
      });
    }
  })
  .transform((value) => ({
    targetTier: value.targetTier ?? value.planTier,
    billingCycle: value.billingCycle,
    note: value.note,
  }));

export const alertDismissBody = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const uploadCompleteBody = z.object({}).strict();

export const staffUpdatePatchBody = z
  .object({
    expectedVersion: z.number().int().positive().optional(),
    name: z.string().trim().min(2).max(120).optional(),
    email: z
      .union([z.string().email(), z.literal("")])
      .optional()
      .transform((value) => (value === "" ? null : value)),
    mobile: mobile.optional(),
    branchId: z.union([z.string().min(4).max(80), z.null()]).optional(),
    status: enumSchema(E.UserStatus).optional(),
    role: enumSchema(E.TenantRole).optional(),
    permissions: z.array(z.string().min(1).max(64)).optional(),
  })
  .strict();

export const cashAdjustmentBody = z
  .object({
    staffId: z.string().min(4).max(80),
    direction: enumSchema(E.CashAdjustmentDirection),
    amountPaise: positivePaise,
    reason: z.string().trim().min(3).max(500),
    branchId: z.string().min(4).max(80).optional(),
  })
  .strict();

export const paymentReverseBody = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const kycVerifyBody = z
  .object({
    status: z.enum(["VERIFIED", "REJECTED"]),
    rejectionReason: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "REJECTED" && !value.rejectionReason?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["rejectionReason"],
        message: "rejectionReason is required when status is REJECTED.",
      });
    }
  });

export const handoverAcceptBody = z
  .object({
    acceptedAmountPaise: positivePaise.optional(),
  })
  .strict();

export const handoverRejectBody = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const handoverResolveDiscrepancyBody = z
  .object({
    accepted: z.boolean(),
    acceptedAmountPaise: positivePaise.optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.accepted === false && !value.reason?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "reason is required when rejecting a discrepancy resolution.",
      });
    }
  });

export const grievanceAssignBody = z
  .object({
    assigneeId: z.string().min(4).max(80).nullable(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const grievancePriorityBody = z
  .object({
    priority: enumSchema(E.GrievancePriority),
    reason: z.string().trim().min(1).max(500).optional(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const grievanceStatusBody = z
  .object({
    status: enumSchema(E.GrievanceStatus),
    expectedVersion: z.number().int().positive(),
  })
  .strict();

const reminderOffsetPatch = z
  .object({
    key: z.string().trim().min(1).max(40),
    enabled: z.boolean().optional(),
    days: z.number().int().min(-365).max(365).optional(),
  })
  .strict();

const reminderPushPatch = z
  .object({
    enabled: z.boolean().optional(),
    mirrorWhatsAppTransactional: z.boolean().optional(),
    dueReminders: z.boolean().optional(),
    overdueReminders: z.boolean().optional(),
    paymentSuccess: z.boolean().optional(),
    schemeJoined: z.boolean().optional(),
    flexiLockApplied: z.boolean().optional(),
    schemeMatured: z.boolean().optional(),
    schemeClosed: z.boolean().optional(),
    flexibleNudge: z.boolean().optional(),
    maturityReminders: z.boolean().optional(),
  })
  .strict();

export const reminderConfigPatchBody = z
  .object({
    expectedVersion: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
    maxRemindersPerInstallment: z.number().int().min(0).max(30).optional(),
    attachPaymentLink: z.boolean().optional(),
    paymentLinkValidityHours: z.number().int().min(1).max(168).optional(),
    flexibleNudgeInactiveDays: z.number().int().min(1).max(90).optional(),
    maxPushPerCustomerPerDay: z.number().int().min(0).max(20).optional(),
    maxWhatsAppPerCustomerPerDay: z.number().int().min(0).max(50).optional(),
    offsets: z.array(reminderOffsetPatch).max(32).optional(),
    sendWindow: z
      .object({
        startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      })
      .strict()
      .optional(),
    push: reminderPushPatch.optional(),
    skipDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  })
  .strict();

export const pushBroadcastBody = z
  .object({
    title: z.string().trim().min(2).max(120),
    body: z.string().trim().min(2).max(500),
    deepLink: z.string().trim().max(500).optional(),
    audience: z.enum(["ALL_DEVICES", "BRANCH", "CUSTOMERS"]).optional(),
    branchId: z.string().min(4).max(80).optional(),
    customerIds: z.array(z.string().min(4).max(80)).max(500).optional(),
    imageUploadId: z.string().min(4).max(80).optional(),
  })
  .strict();

export const pushBroadcastAudiencePreviewBody = z
  .object({
    title: z.string().trim().min(2).max(120).optional(),
    body: z.string().trim().min(2).max(500).optional(),
    audience: z.enum(["ALL_DEVICES", "BRANCH", "CUSTOMERS"]).optional(),
    branchId: z.string().min(4).max(80).optional(),
    customerIds: z.array(z.string().min(4).max(80)).max(500).optional(),
  })
  .strict();

export const bulkMessagingSchemeIdsBody = z
  .object({
    schemeIds: z.array(z.string().min(4).max(80)).min(1).max(500),
  })
  .strict();

export const bulkMessageResendBody = z
  .object({
    messageIds: z.array(z.string().min(4).max(80)).min(1).max(200),
  })
  .strict();

export const reportExportAliasParam = z.object({
  reportKey: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .transform((value) => value.toUpperCase().replace(/-/g, "_"))
    .pipe(enumSchema(E.ExportType)),
});

export const reportExportAliasBody = z
  .object({
    format: z.enum(["CSV", "PDF"]).optional(),
    filters: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const branchActionBody = z.object({}).strict();

export const paymentReconcileBody = z
  .object({
    forceReplay: z.boolean().optional(),
  })
  .strict();
