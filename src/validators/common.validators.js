import { z } from "zod";
import * as E from "../constants/enums.js";
import { canonicalMobile } from "../lib/mobile.js";

export const idParam = (name) => z.object({ [name]: z.string().min(4).max(80) });
export const cursorQuery = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(20), sort: z.string().optional(), q: z.string().trim().max(120).optional() }).passthrough();
export const idempotencyHeader = z.object({ "x-idempotency-key": z.string().uuid() }).passthrough();
const enumSchema = (enumeration) => z.enum(Object.values(enumeration));
export const mobile = z.string().regex(/^\+?[1-9]\d{9,14}$/);
export const paise = z.number().int().safe().nonnegative();
export const positivePaise = z.number().int().safe().positive();

export const loginBody = z.object({ tenantCode: z.string().trim().toUpperCase().optional(), mobile, password: z.string().min(8), deviceId: z.string().min(4), platform: z.enum(["web", "android", "ios"]).default("web"), appVersion: z.string().optional() });
export const platformLoginBody = z.object({ email: z.string().email(), password: z.string().min(8), deviceId: z.string().min(4).optional(), platform: z.enum(["web", "android", "ios"]).default("web").optional() });
export const signupStartBody = z.object({
  businessName: z.string().trim().min(2).max(160),
  ownerName: z.string().trim().min(2).max(120),
  mobile,
  email: z.string().email(),
  city: z.string().trim().min(2).max(80),
});
export const signupVerifyBody = z.object({ signupId: z.string().min(4), otp: z.string().regex(/^\d{4,8}$/) });
export const signupSelectPlanBody = z.object({ subscriptionPlanId: z.string().min(4), billingCycle: enumSchema(E.BillingCycle).default(E.BillingCycle.MONTHLY) });
export const signupPaymentBody = z.object({ redirectUrl: z.string().url() });
export const otpRequestBody = z.object({ tenantCode: z.string().trim().toUpperCase(), mobile, purpose: z.enum(["LOGIN", "SIGNUP", "PASSWORD_RESET"]).default("LOGIN"), deviceId: z.string().min(4) });
export const otpVerifyBody = otpRequestBody.extend({ otp: z.string().regex(/^\d{4,8}$/) });
export const forgotPasswordBody = z.object({ tenantCode: z.string().trim().toUpperCase(), mobile, deviceId: z.string().min(4).optional() });
export const setPasswordBody = z.object({ resetToken: z.string().min(32).optional(), password: z.string().min(8).max(128) });
export const publicSetPasswordBody = z.object({
  token: z.string().min(8).optional(),
  resetToken: z.string().min(32).optional(),
  password: z.string().min(8).max(128),
  confirmPassword: z.string().min(8).max(128).optional(),
}).superRefine((value, context) => {
  if (!value.token && !value.resetToken) {
    context.addIssue({ code: "custom", path: ["token"], message: "token or resetToken is required." });
    return;
  }
  if (value.token) {
    if (!value.confirmPassword) context.addIssue({ code: "custom", path: ["confirmPassword"], message: "confirmPassword is required." });
    else if (value.password !== value.confirmPassword) context.addIssue({ code: "custom", path: ["confirmPassword"], message: "Password and confirm password must match." });
  }
});
const mobileField = z.preprocess(
  (value) => (value == null || value === "" ? value : canonicalMobile(value)),
  mobile,
);
export const customerBody = z.object({
  branchId: z.string().optional(),
  name: z.string().trim().min(2).max(120),
  mobile: mobileField,
  email: z
    .union([z.string().email(), z.literal("")])
    .optional()
    .transform((value) => (value === "" ? undefined : value)),
  dateOfBirth: z.string().optional(),
  address: z.string().max(1000).optional(),
  passbookNumber: z
    .union([z.string().max(80), z.literal("")])
    .optional()
    .transform((value) => (value === "" ? undefined : value)),
});
export const nomineeBody = z.object({ name: z.string().min(2).max(120), relationship: enumSchema(E.NomineeRelationship), mobile: mobile.optional(), dateOfBirth: z.string().optional(), address: z.string().max(1000).optional(), expectedVersion: z.number().int().positive() });
const nullablePaise = z.number().int().safe().nonnegative().nullable().optional();
const amountRules = z.object({ amountMode: enumSchema(E.AmountMode), fixedAmountPaise: nullablePaise, slabsPaise: z.array(positivePaise).default([]), minInstallmentPaise: nullablePaise, maxInstallmentPaise: nullablePaise, multipleOfPaise: nullablePaise });
const scheduleRules = z.object({ dueDateRule: enumSchema(E.DueDateRule), dueDayOfMonth: z.number().int().min(1).max(31).nullable().optional(), graceDays: z.number().int().min(0).max(90).default(0), firstInstallmentModeDefault: enumSchema(E.FirstInstallmentMode), firstInstallmentModeEditable: z.boolean().default(false) });
const paymentRules = z.object({ partialPaymentAllowed: z.boolean().default(false), advancePaymentAllowed: z.boolean().default(false), maxAdvanceInstallments: z.number().int().min(0).max(120).default(0), minPaymentPaise: nullablePaise, maxPaymentPerTransactionPaise: nullablePaise });
const flexibleRules = z.object({ phaseMode: enumSchema(E.PhaseMode), capMode: enumSchema(E.CapMode), carryForwardMode: enumSchema(E.CarryForwardMode), flexiblePhaseCycles: z.number().int().positive(), cappedPhaseCycles: z.number().int().positive(), averagingDivisor: z.number().int().positive(), frequencyMode: enumSchema(E.FlexibleFrequencyMode), flexiblePhase: z.object({ minimumPaymentPaise: positivePaise, maximumPaymentPaise: positivePaise, paymentIncrementPaise: positivePaise, minTotalPaise: paise, maxPaymentsPerCycle: z.number().int().positive().nullable().optional(), paymentsRequiredPerCycle: z.literal(0) }), capComputation: z.object({ formula: enumSchema(E.CapFormula), roundingMode: enumSchema(E.CapRoundingMode), roundToNearestPaise: positivePaise, minCycleCapPaise: positivePaise, maxCycleCapPaise: positivePaise, onZeroFlexiblePhaseTotal: enumSchema(E.ZeroFlexibleTotalAction), onBelowMinimumTotal: enumSchema(E.BelowMinimumTotalAction) }), cappedPhase: z.object({ minimumPaymentPaise: positivePaise, paymentIncrementPaise: positivePaise, allowFinalRemainderBelowMinimum: z.boolean(), allowFutureCyclePayment: z.boolean(), maxAdvanceCycles: z.number().int().min(0) }), extensionMode: z.literal("EXTEND_FLEXIBLE_PHASE").optional() });
const benefitEligibility = z.object({
  requireAllInstallmentsPaid: z.boolean(),
  maxAllowedDefaults: z.number().int().min(0),
  minMonthsCompleted: z.number().int().min(0),
});
const benefit = z
  .object({
    type: enumSchema(E.BenefitType),
    bonusBasis: enumSchema(E.BonusBasis).nullable().optional(),
    bonusValue: z.number().int().nonnegative().nullable().optional(),
    maxBonusPaise: nullablePaise,
    textBenefit: z.string().max(4000).nullable().optional(),
    eligibility: benefitEligibility,
    displayLabel: z.string().max(160),
  })
  .superRefine((value, context) => {
    if (value.type !== E.BenefitType.FIXED_BONUS_AMOUNT) return;
    if (value.bonusBasis === E.BonusBasis.FLAT) {
      if (value.bonusValue == null || value.bonusValue < 1) {
        context.addIssue({
          code: "custom",
          path: ["bonusValue"],
          message: "Flat bonus requires bonusValue in paise (positive integer).",
        });
      }
      return;
    }
    if (value.bonusBasis === E.BonusBasis.PERCENT_OF_PAID) {
      if (value.bonusValue == null || value.bonusValue > 100) {
        context.addIssue({
          code: "custom",
          path: ["bonusValue"],
          message: "Percent bonus must be an integer from 0 to 100.",
        });
      }
    }
  });
const prematurePenalty = z
  .object({
    mode: enumSchema(E.PrematurePenaltyMode),
    value: z.number().int().nonnegative().nullable().optional(),
    flatPaise: nullablePaise,
    benefitTreatment: enumSchema(E.BenefitTreatment),
  })
  .superRefine((value, context) => {
    if (value.mode === E.PrematurePenaltyMode.PERCENT_OF_PAID) {
      if (value.value != null && value.value > 100) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: "Penalty percent must be from 0 to 100.",
        });
      }
      return;
    }
    if (value.mode === E.PrematurePenaltyMode.FLAT) {
      const flat = value.flatPaise ?? value.value;
      if (flat == null || flat < 1) {
        context.addIssue({
          code: "custom",
          path: ["flatPaise"],
          message: "Flat penalty requires flatPaise (positive integer).",
        });
      }
    }
  });
const redemptionRules = z.object({
  prematureClosureAllowed: z.boolean(),
  lockInMonths: z.number().int().min(0),
  prematurePenalty,
  allowedModes: z.array(enumSchema(E.RedemptionMode)).min(1),
  redeemAtAnyBranch: z.boolean(),
});
const availability = z.object({ allBranches: z.boolean(), branchIds: z.array(z.string()).default([]), enrolmentOpenFrom: z.string().nullable().optional(), enrolmentOpenTo: z.string().nullable().optional(), maxEnrolments: z.number().int().positive().nullable().optional(), visibleInCustomerApp: z.boolean(), customerSelfEnrolAllowed: z.boolean() });
const goldRules = z.object({ rateSource: enumSchema(E.GoldRateSource), weightRoundingMode: enumSchema(E.WeightRoundingMode), weightPrecisionMg: z.number().int().positive(), blockPaymentIfRateNotSet: z.boolean() });

function refinePlanCrossFields(value, context, { requireComplete = true } = {}) {
  const pattern = value.paymentPattern;
  if (pattern === E.PaymentPattern.FLEXIBLE) {
    if (value.flexibleRules === null) {
      context.addIssue({
        code: "custom",
        path: ["flexibleRules"],
        message: "Flexible plans require flexibleRules.",
      });
    } else if (requireComplete && !value.flexibleRules) {
      context.addIssue({
        code: "custom",
        path: ["flexibleRules"],
        message: "Flexible plans require flexibleRules.",
      });
    }
  }
  if (pattern === E.PaymentPattern.FIXED && value.flexibleRules) {
    context.addIssue({
      code: "custom",
      path: ["flexibleRules"],
      message: "Fixed plans must not define flexibleRules.",
    });
  }
  const basis = value.valueBasis;
  if (basis === E.ValueBasis.GOLD_WEIGHT) {
    if (value.goldRules === null) {
      context.addIssue({
        code: "custom",
        path: ["goldRules"],
        message: "Gold-weight plans require goldRules.",
      });
    } else if (requireComplete && !value.goldRules) {
      context.addIssue({
        code: "custom",
        path: ["goldRules"],
        message: "Gold-weight plans require goldRules.",
      });
    }
  }
  if (
    pattern === E.PaymentPattern.FLEXIBLE
    && value.benefit?.type === E.BenefitType.ONE_FREE_INSTALLMENT
  ) {
    context.addIssue({
      code: "custom",
      path: ["benefit", "type"],
      message: "Flexible plans cannot use one free installment. Use fixed bonus or text-only benefit.",
    });
  }
  if (
    value.scheduleRules?.dueDateRule === E.DueDateRule.FIXED_DAY_OF_MONTH
    && (value.scheduleRules.dueDayOfMonth == null
      || value.scheduleRules.dueDayOfMonth < 1
      || value.scheduleRules.dueDayOfMonth > 31)
  ) {
    context.addIssue({
      code: "custom",
      path: ["scheduleRules", "dueDayOfMonth"],
      message: "Fixed-day schedules require dueDayOfMonth between 1 and 31.",
    });
  }
}

const planFields = {
  name: z.string().min(2).max(120),
  code: z.string().regex(/^[A-Z0-9_-]{2,20}$/),
  displayName: z.string().max(120).optional(),
  description: z.string().max(2000).optional(),
  termsText: z.string().max(10000).optional(),
  valueBasis: enumSchema(E.ValueBasis),
  paymentPattern: enumSchema(E.PaymentPattern),
  durationMonths: z.number().int().min(1).max(120),
  installmentCount: z.number().int().min(1).max(120),
  amountRules,
  scheduleRules,
  paymentRules,
  flexibleRules: flexibleRules.nullable().optional(),
  goldRules: goldRules.nullable().optional(),
  benefit: benefit.optional(),
  redemptionRules,
  availability,
  status: enumSchema(E.SchemePlanStatus).default(E.SchemePlanStatus.DRAFT),
};

export const planBody = z
  .object(planFields)
  .superRefine((value, context) => refinePlanCrossFields(value, context, { requireComplete: true }));

const benefitPatch = z
  .object({
    type: enumSchema(E.BenefitType).optional(),
    bonusBasis: enumSchema(E.BonusBasis).nullable().optional(),
    bonusValue: z.number().int().nonnegative().nullable().optional(),
    maxBonusPaise: nullablePaise,
    textBenefit: z.string().max(4000).nullable().optional(),
    eligibility: benefitEligibility.partial().optional(),
    displayLabel: z.string().max(160).optional(),
  })
  .superRefine((value, context) => {
    if (value.type !== E.BenefitType.FIXED_BONUS_AMOUNT) return;
    if (value.bonusBasis === E.BonusBasis.FLAT) {
      if (value.bonusValue == null || value.bonusValue < 1) {
        context.addIssue({
          code: "custom",
          path: ["bonusValue"],
          message: "Flat bonus requires bonusValue in paise (positive integer).",
        });
      }
      return;
    }
    if (value.bonusBasis === E.BonusBasis.PERCENT_OF_PAID) {
      if (value.bonusValue != null && value.bonusValue > 100) {
        context.addIssue({
          code: "custom",
          path: ["bonusValue"],
          message: "Percent bonus must be an integer from 0 to 100.",
        });
      }
    }
  });

export const planPatchBody = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: planFields.name.optional(),
    displayName: planFields.displayName,
    description: planFields.description,
    termsText: planFields.termsText,
    valueBasis: planFields.valueBasis.optional(),
    paymentPattern: planFields.paymentPattern.optional(),
    durationMonths: planFields.durationMonths.optional(),
    installmentCount: planFields.installmentCount.optional(),
    amountRules: amountRules.optional(),
    scheduleRules: scheduleRules.optional(),
    paymentRules: paymentRules.optional(),
    flexibleRules: flexibleRules.nullable().optional(),
    goldRules: goldRules.nullable().optional(),
    benefit: benefitPatch.optional(),
    redemptionRules: redemptionRules.optional(),
    availability: availability.partial().optional(),
    status: planFields.status.optional(),
  })
  .superRefine((value, context) =>
    refinePlanCrossFields(value, context, { requireComplete: false }),
  );

const previewScheduleExtras = {
  planId: z.string().min(4).max(80).optional(),
  installmentAmountPaise: positivePaise,
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  firstInstallmentMode: enumSchema(E.FirstInstallmentMode).optional(),
};

function normalizePreviewDraftBody(value) {
  const name = String(value.name ?? "").trim();
  const code = String(value.code ?? "")
    .trim()
    .toUpperCase();
  return {
    ...value,
    name: name.length >= 2 ? name : "Preview plan",
    code: /^[A-Z0-9_-]{2,20}$/.test(code) ? code : "DRAFT",
  };
}

export const previewScheduleBody = z
  .object(previewScheduleExtras)
  .passthrough()
  .superRefine((value, context) => {
    if (value.planId) return;
    const parsed = planBody.safeParse(normalizePreviewDraftBody(value));
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      context.addIssue(issue);
    }
  });
export const enrolBody = z.object({ customerId: z.string(), planId: z.string(), branchId: z.string().optional(), installmentAmountPaise: positivePaise.optional(), firstInstallmentMode: enumSchema(E.FirstInstallmentMode), firstInstallmentAction: enumSchema(E.FirstInstallmentAction).optional(), payment: z.record(z.string(), z.unknown()).optional() });
export const paymentBody = z.object({
  schemeId: z.string(),
  amountPaise: positivePaise,
  mode: enumSchema(E.ManualPaymentMode),
  targetCycle: z.string().regex(/^\d{4}-\d{2}$/).nullish(),
  expectedVersion: z.number().int().positive().nullish(),
  expectedPositionVersion: z.number().int().nonnegative().nullish(),
  positionVersion: z.number().int().nonnegative().nullish(),
  reference: z.string().max(160).nullish(),
  remarks: z.string().max(500).nullish(),
});
export const paymentIntentBody = z.object({
  amountPaise: positivePaise,
  targetCycle: z.string().regex(/^\d{4}-\d{2}$/).nullish(),
  expectedPositionVersion: z.number().int().nonnegative().nullish(),
  positionVersion: z.number().int().nonnegative().nullish(),
  redirectUrl: z.string().url().nullish(),
  mobile: mobile.nullish(),
});
export const paymentLinkBody = z.object({
  schemeId: z.string(),
  amountPaise: positivePaise,
  targetCycle: z.string().regex(/^\d{4}-\d{2}$/).nullish(),
  expectedPositionVersion: z.number().int().nonnegative().nullish(),
  positionVersion: z.number().int().nonnegative().nullish(),
  expiresInMinutes: z.number().int().positive().nullish(),
});
export const customerPatchBody = customerBody.partial().extend({ expectedVersion: z.number().int().positive().optional() });
export const customerNoteBody = z.object({ note: z.string().trim().min(1).max(4000) });
export const whatsappOptBody = z.object({ optedIn: z.boolean() });
export const kycSubmitBody = z.object({ type: enumSchema(E.KycType), number: z.string().min(4).max(32).optional(), numberMasked: z.string().max(32).optional(), frontUploadId: z.string().optional(), backUploadId: z.string().optional() });
export const customerBlockBody = z.object({ reason: z.string().trim().min(3).max(500).optional() });
export const goldRateBody = z.object({ branchId: z.string().nullable().optional(), ratePerGramPaise: positivePaise, effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), purity: z.string().default("22K"), source: z.string().max(120).optional() });
export const grievanceBody = z.object({ category: enumSchema(E.GrievanceCategory), subject: z.string().min(5).max(140), description: z.string().min(10).max(4000), relatedEntity: z.object({ type: z.enum(["PAYMENT", "SCHEME", "REDEMPTION"]), id: z.string() }).optional(), attachmentUploadIds: z.array(z.string()).max(5).default([]) });
export const messageBody = z.object({ body: z.string().min(1).max(4000), messageType: enumSchema(E.GrievanceMessageType).default(E.GrievanceMessageType.PUBLIC_REPLY), attachmentUploadIds: z.array(z.string()).max(5).default([]), expectedVersion: z.number().int().positive().optional() });
export const handoverBody = z.object({ amountPaise: positivePaise, remarks: z.string().max(500).optional(), staffId: z.string().optional(), branchId: z.string().optional() });
export const redemptionBody = z.object({ mode: enumSchema(E.RedemptionMode), modeDetails: z.record(z.string(), z.unknown()).optional(), expectedVersion: z.number().int().positive() });
export const uploadBody = z.object({ purpose: enumSchema(E.UploadPurpose), fileName: z.string().min(1).max(255), contentType: z.string(), sizeBytes: z.number().int().positive() });
export const exportBody = z.object({ type: enumSchema(E.ExportType), filters: z.record(z.string(), z.unknown()).default({}), format: z.enum(["CSV", "XLSX", "PDF"]).default("CSV") });
