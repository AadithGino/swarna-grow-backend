import { z } from "zod";
import * as E from "../constants/enums.js";
import { flexiblePhaseTargetMonths } from "../lib/flexible-plan-duration.js";
import { canonicalMobile } from "../lib/mobile.js";
import {
  isValidCalendarDateString,
  refineCalendarDateField,
  refinePlanSatisfiability,
} from "../lib/plan-satisfiability.js";

export const idParam = (name) => z.object({ [name]: z.string().min(4).max(80) });
export const cursorQuery = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(20), sort: z.string().optional(), q: z.string().trim().max(120).optional() }).passthrough();
export const idempotencyHeader = z.object({ "x-idempotency-key": z.string().uuid() }).passthrough();
const enumSchema = (enumeration) => z.enum(Object.values(enumeration));
export const mobile = z.string().regex(/^\+?[1-9]\d{9,14}$/);
export const paise = z.number().int().safe().nonnegative();
export const positivePaise = z.number().int().safe().positive();
export const customerAddressValue = z.union([
  z.string().trim().min(3).max(1000),
  z
    .object({
      line1: z.string().trim().min(1).max(200),
      line2: z.string().trim().max(200).optional(),
      city: z.string().trim().max(80).optional(),
      state: z.string().trim().max(80).optional(),
      pincode: z.string().trim().max(12).optional(),
    })
    .strict(),
]);
export const PASSWORD_PIN_MESSAGE =
  "Password must be at least 4 digits (numbers only).";
export const passwordPolicySchema = z
  .string()
  .min(4)
  .max(128)
  .regex(/^\d+$/, PASSWORD_PIN_MESSAGE);

export const loginBody = z.object({ tenantCode: z.string().trim().toUpperCase().optional(), mobile, password: passwordPolicySchema, deviceId: z.string().min(4), platform: z.enum(["web", "android", "ios"]).default("web"), appVersion: z.string().optional() });
export const platformLoginBody = z.object({ email: z.string().email(), password: passwordPolicySchema, deviceId: z.string().min(4).optional(), platform: z.enum(["web", "android", "ios"]).default("web").optional() });
export const changePasswordBody = z.object({
  currentPassword: passwordPolicySchema,
  newPassword: passwordPolicySchema,
});
const platformAppPlatformPatch = z.object({
  minimumVersion: z.string().trim().min(1).max(32).optional(),
  latestVersion: z.string().trim().min(1).max(32).optional(),
  forceUpdate: z.boolean().optional(),
  storeUrl: z.string().url().nullable().optional(),
});
export const platformAppConfigBody = z.object({
  android: platformAppPlatformPatch.optional(),
  ios: platformAppPlatformPatch.optional(),
  maintenance: z.object({
    enabled: z.boolean().optional(),
    title: z.string().trim().max(120).nullable().optional(),
    message: z.string().trim().max(500).nullable().optional(),
  }).optional(),
}).strict();
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
export const otpVerifyBody = otpRequestBody.extend({
  otp: z.string().regex(/^\d{4,8}$/),
  otpId: z.string().uuid(),
  deviceInfo: z.object({
    deviceId: z.string().min(4),
    platform: z.enum(["android", "ios", "web"]).optional(),
    appVersion: z.string().max(32).optional(),
    osVersion: z.string().max(32).optional(),
    deviceModel: z.string().max(64).optional(),
  }).optional(),
});
export const appEnrolBody = z.object({
  planId: z.string(),
  installmentAmountPaise: positivePaise.optional(),
  payNow: z.boolean().optional(),
  redirectUrl: z.string().url().optional(),
});
export const appProfileCompleteBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    email: z
      .union([z.string().email(), z.literal("")])
      .optional()
      .transform((value) => (value === "" ? undefined : value)),
    address: customerAddressValue,
  })
  .strict();

export const appProfilePatchBody = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    email: z
      .union([z.string().email(), z.literal("")])
      .optional()
      .transform((value) => (value === "" ? undefined : value)),
    address: customerAddressValue.optional(),
  })
  .strict();
export const customerGrievanceMessageBody = z.object({
  body: z.string().min(1).max(4000),
  attachmentUploadIds: z.array(z.string()).max(5).default([]),
  expectedVersion: z.number().int().positive(),
});
export const grievanceReopenBody = z.object({
  reason: z.string().trim().min(3).max(500),
  expectedVersion: z.number().int().positive(),
});
export const settlementPreviewQuery = z.object({
  type: z.enum([E.ClosureType.MATURITY_REDEMPTION, E.ClosureType.PREMATURE_CLOSURE]).optional(),
  mode: enumSchema(E.RedemptionMode).optional(),
});

export const customerRedemptionRequestBody = z
  .object({
    preferredMode: enumSchema(E.RedemptionMode),
    preferredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    remarks: z.string().max(500).optional(),
    expectedVersion: z.number().int().positive(),
    modeDetails: z
      .object({
        billNumber: z.string().trim().min(1).max(64).optional(),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    refineCalendarDateField(context, ["preferredDate"], value.preferredDate);
  });
export const cancelPaymentIntentBody = z.object({
  expectedPositionVersion: z.number().int().nonnegative(),
});
export const fcmTokenBody = z.object({
  fcmToken: z.string().min(20),
  deviceId: z.string().min(4),
  platform: z.enum(["android", "ios"]),
  appVersion: z.string().max(32).optional(),
  osVersion: z.string().max(32).optional(),
  deviceModel: z.string().max(64).optional(),
});
export const fcmRegisterBody = fcmTokenBody;
export const fcmDeleteBody = z.object({ deviceId: z.string().min(4) });
export const forgotPasswordBody = z.object({ tenantCode: z.string().trim().toUpperCase(), mobile, deviceId: z.string().min(4).optional() });
export const setPasswordBody = z.object({ resetToken: z.string().min(32).optional(), password: passwordPolicySchema });
export const customerPasswordLoginBody = z.object({
  tenantCode: z.string().trim().toUpperCase(),
  mobile,
  password: passwordPolicySchema,
  deviceId: z.string().min(4).optional(),
});
export const customerSetPasswordBody = z.object({
  password: passwordPolicySchema,
  mustChangeOnNextLogin: z.boolean().optional(),
});
export const publicSetPasswordBody = z.object({
  token: z.string().min(8).optional(),
  resetToken: z.string().min(32).optional(),
  password: passwordPolicySchema,
  confirmPassword: passwordPolicySchema.optional(),
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
export const customerBody = z
  .object({
    branchId: z.string().optional(),
    name: z.string().trim().min(2).max(120),
    mobile: mobileField,
    email: z
      .union([z.string().email(), z.literal("")])
      .optional()
      .transform((value) => (value === "" ? undefined : value)),
    address: customerAddressValue,
    passbookNumber: z
      .union([z.string().max(80), z.literal("")])
      .optional()
      .transform((value) => (value === "" ? undefined : value)),
  })
  .strict();
export const customerPatchBody = customerBody
  .partial()
  .extend({ expectedVersion: z.number().int().positive().optional() })
  .strict();
export const nomineeBody = z.object({ name: z.string().min(2).max(120), relationship: enumSchema(E.NomineeRelationship), mobile: mobile.optional(), address: z.string().max(1000).optional(), expectedVersion: z.number().int().positive() });
export const nomineeVersionBody = z.object({ expectedVersion: z.number().int().positive() });
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
  if (value.durationMonths != null && value.installmentCount != null) {
    if (value.installmentCount > value.durationMonths) {
      context.addIssue({
        code: "custom",
        path: ["installmentCount"],
        message: "installmentCount cannot exceed durationMonths.",
      });
    }
  }
  if (
    pattern === E.PaymentPattern.FLEXIBLE
    && value.flexibleRules
    && value.durationMonths != null
  ) {
    const flexMonths = value.flexibleRules.flexiblePhaseCycles ?? 0;
    const cappedMonths = value.flexibleRules.cappedPhaseCycles ?? 0;
    const paymentMonths = flexiblePhaseTargetMonths(value);
    if (flexMonths + cappedMonths !== paymentMonths) {
      context.addIssue({
        code: "custom",
        path: ["flexibleRules"],
        message:
          "flexiblePhaseCycles + cappedPhaseCycles must equal installmentCount (payment months).",
      });
    }
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
  const amountRules = value.amountRules ?? {};
  if (amountRules.amountMode === E.AmountMode.JEWELLER_FIXED) {
    if (amountRules.fixedAmountPaise == null || amountRules.fixedAmountPaise < 1) {
      context.addIssue({
        code: "custom",
        path: ["amountRules", "fixedAmountPaise"],
        message: "Fixed amount mode requires fixedAmountPaise.",
      });
    }
  }
  if (amountRules.amountMode === E.AmountMode.JEWELLER_SLABS) {
    if (!amountRules.slabsPaise?.length) {
      context.addIssue({
        code: "custom",
        path: ["amountRules", "slabsPaise"],
        message: "Slab amount mode requires at least one slab.",
      });
    }
  }
  if (amountRules.amountMode === E.AmountMode.CUSTOMER_CHOSEN) {
    if (amountRules.minInstallmentPaise == null || amountRules.minInstallmentPaise < 1) {
      context.addIssue({
        code: "custom",
        path: ["amountRules", "minInstallmentPaise"],
        message: "Customer-chosen amount mode requires minInstallmentPaise.",
      });
    }
    if (amountRules.maxInstallmentPaise == null || amountRules.maxInstallmentPaise < 1) {
      context.addIssue({
        code: "custom",
        path: ["amountRules", "maxInstallmentPaise"],
        message: "Customer-chosen amount mode requires maxInstallmentPaise.",
      });
    }
  }
  if (
    amountRules.minInstallmentPaise != null
    && amountRules.maxInstallmentPaise != null
    && amountRules.minInstallmentPaise > amountRules.maxInstallmentPaise
  ) {
    context.addIssue({
      code: "custom",
      path: ["amountRules", "maxInstallmentPaise"],
      message: "minInstallmentPaise cannot exceed maxInstallmentPaise.",
    });
  }
  const flex = value.flexibleRules;
  if (flex?.flexiblePhase) {
    const minP = flex.flexiblePhase.minimumPaymentPaise;
    const maxP = flex.flexiblePhase.maximumPaymentPaise;
    if (minP != null && maxP != null && minP > maxP) {
      context.addIssue({
        code: "custom",
        path: ["flexibleRules", "flexiblePhase", "maximumPaymentPaise"],
        message: "Flexible minimum payment cannot exceed maximum payment.",
      });
    }
  }
  if (flex?.capComputation) {
    const minCap = flex.capComputation.minCycleCapPaise;
    const maxCap = flex.capComputation.maxCycleCapPaise;
    if (minCap != null && maxCap != null && minCap > maxCap) {
      context.addIssue({
        code: "custom",
        path: ["flexibleRules", "capComputation", "maxCycleCapPaise"],
        message: "minCycleCapPaise cannot exceed maxCycleCapPaise.",
      });
    }
  }
  const availabilityRules = value.availability ?? {};
  if (availabilityRules.allBranches === false && !(availabilityRules.branchIds?.length)) {
    context.addIssue({
      code: "custom",
      path: ["availability", "branchIds"],
      message: "Select at least one branch when allBranches is false.",
    });
  }
  refineCalendarDateField(context, ["availability", "enrolmentOpenFrom"], availabilityRules.enrolmentOpenFrom);
  refineCalendarDateField(context, ["availability", "enrolmentOpenTo"], availabilityRules.enrolmentOpenTo);
  if (
    availabilityRules.enrolmentOpenFrom
    && availabilityRules.enrolmentOpenTo
    && isValidCalendarDateString(availabilityRules.enrolmentOpenFrom)
    && isValidCalendarDateString(availabilityRules.enrolmentOpenTo)
    && availabilityRules.enrolmentOpenFrom > availabilityRules.enrolmentOpenTo
  ) {
    context.addIssue({
      code: "custom",
      path: ["availability", "enrolmentOpenTo"],
      message: "enrolmentOpenFrom cannot be after enrolmentOpenTo.",
    });
  }
  const redemption = value.redemptionRules ?? {};
  if (
    redemption.lockInMonths != null
    && value.durationMonths != null
    && redemption.lockInMonths > value.durationMonths
  ) {
    context.addIssue({
      code: "custom",
      path: ["redemptionRules", "lockInMonths"],
      message: "lockInMonths cannot exceed durationMonths.",
    });
  }
  const paymentRules = value.paymentRules ?? {};
  if (
    paymentRules.advancePaymentAllowed === false
    && (paymentRules.maxAdvanceInstallments ?? 0) > 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["paymentRules", "maxAdvanceInstallments"],
      message: "maxAdvanceInstallments must be 0 when advance payments are disabled.",
    });
  }
  if (
    paymentRules.advancePaymentAllowed === true
    && (paymentRules.maxAdvanceInstallments ?? 0) < 1
  ) {
    context.addIssue({
      code: "custom",
      path: ["paymentRules", "maxAdvanceInstallments"],
      message: "maxAdvanceInstallments must be at least 1 when advance payments are enabled.",
    });
  }
  if (
    pattern === E.PaymentPattern.FLEXIBLE
    && paymentRules.maxPaymentPerTransactionPaise != null
  ) {
    context.addIssue({
      code: "custom",
      path: ["paymentRules", "maxPaymentPerTransactionPaise"],
      message: "Per-transaction cap is not supported for flexible plans.",
    });
  }
  const benefit = value.benefit;
  if (benefit?.type === E.BenefitType.FIXED_BONUS_AMOUNT && benefit.bonusBasis == null) {
    context.addIssue({
      code: "custom",
      path: ["benefit", "bonusBasis"],
      message: "Fixed bonus requires bonusBasis.",
    });
  }
  const penalty = redemption.prematurePenalty;
  if (penalty?.mode === E.PrematurePenaltyMode.PERCENT_OF_PAID) {
    if (penalty.value == null || penalty.value < 0 || penalty.value > 100) {
      context.addIssue({
        code: "custom",
        path: ["redemptionRules", "prematurePenalty", "value"],
        message: "Percent penalty requires value from 0 to 100.",
      });
    }
  }
  refinePlanSatisfiability(value, context);
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
    /** No `.default(DRAFT)` — optional()+default on PATCH was resetting Active plans on every save. */
    status: enumSchema(E.SchemePlanStatus).optional(),
  });

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
export const paymentBody = z
  .object({
    schemeId: z.string(),
    amountPaise: positivePaise,
    mode: enumSchema(E.ManualPaymentMode),
    targetCycle: z.string().regex(/^\d{4}-\d{2}$/).nullish(),
    expectedVersion: z.number().int().positive().nullish(),
    expectedPositionVersion: z.number().int().nonnegative().nullish(),
    positionVersion: z.number().int().nonnegative().nullish(),
    reference: z.string().max(160).nullish(),
    remarks: z.string().max(500).nullish(),
  })
  .strict();
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
  expiresInMinutes: z.number().int().positive().max(30).nullish(),
});
export const customerNoteBody = z.object({ note: z.string().trim().min(1).max(4000) });
export const whatsappOptBody = z.object({ optedIn: z.boolean() });
export const kycSubmitBody = z
  .object({
    type: enumSchema(E.KycType),
    number: z.string().min(4).max(32).optional(),
    numberMasked: z.string().max(32).optional(),
    frontUploadId: z.string().optional(),
    backUploadId: z.string().optional(),
  })
  .strict();
export const customerBlockBody = z.object({ reason: z.string().trim().min(3).max(500).optional() });
export const tenantOperationsPatchBody = z
  .object({
    expectedVersion: z.number().int().positive(),
    multiSchemePerCustomer: z.boolean().optional(),
    kycMandatory: z.boolean().optional(),
    requireKycForRedemption: z.boolean().optional(),
    customerAppMaintenance: z.boolean().optional(),
    kycAllowedTypes: z
      .array(enumSchema(E.KycType))
      .min(1)
      .max(8)
      .transform((values) => [...new Set(values)])
      .optional(),
    customerSelfEnrolEnabled: z.boolean().optional(),
    customerSelfRegistrationEnabled: z.boolean().optional(),
    customerLoginMode: enumSchema(E.CustomerLoginMode).optional(),
    customerAppWriteEnabled: z.boolean().optional(),
    customerAppPaymentsEnabled: z.boolean().optional(),
    agentCanRegisterCustomers: z.boolean().optional(),
    agentCanEnrolSchemes: z.boolean().optional(),
    receiptPrefix: z.string().optional(),
    receiptNumberFormat: z.string().optional(),
    passbookNumberFormat: z.string().optional(),
    schemeNumberFormat: z.string().optional(),
    goldPurity: z.literal("22K").optional(),
    weightRoundingMode: enumSchema(E.WeightRoundingMode).optional(),
    paymentReversalWindowHours: z.number().int().positive().optional(),
    redemptionApprovalRequired: z.boolean().optional(),
    termsAndConditions: z.string().optional(),
  })
  .strict();

const branchAddressBody = z
  .object({
    line1: z.string().trim().min(1).max(500).optional(),
    city: z.string().trim().min(1).max(120).optional(),
    pincode: z.string().trim().min(1).max(12).optional(),
  })
  .strict();

export const branchCreateBody = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .transform((value) => value.toUpperCase()),
    name: z.string().trim().min(1).max(160),
    address: z.union([z.string().trim().min(1).max(500), branchAddressBody]).optional(),
    email: z.string().email().optional(),
    contactNumber: mobile.optional(),
    mobile: mobile.optional(),
    isHeadOffice: z.boolean().optional(),
  })
  .strict();

export const branchUpdateBody = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    address: z.union([z.string().trim().min(1).max(500), branchAddressBody]).optional(),
    email: z.string().email().optional(),
    contactNumber: mobile.optional(),
    mobile: mobile.optional(),
    isHeadOffice: z.boolean().optional(),
    expectedVersion: z.number().int().min(0).optional(),
  })
  .strict();

export const goldRateBody = z
  .object({
    branchId: z.string().nullable().optional(),
    ratePerGramPaise: positivePaise,
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    purity: z.literal("22K").default("22K"),
    source: z.string().max(120).optional(),
  })
  .superRefine((value, context) => {
    refineCalendarDateField(context, ["effectiveDate"], value.effectiveDate);
  });
export const grievanceBody = z.object({ category: enumSchema(E.GrievanceCategory), subject: z.string().min(5).max(140), description: z.string().min(10).max(4000), relatedEntity: z.object({ type: z.enum(["PAYMENT", "SCHEME", "REDEMPTION"]), id: z.string() }).optional(), attachmentUploadIds: z.array(z.string()).max(5).default([]) });
export const messageBody = z.object({ body: z.string().min(1).max(4000), messageType: enumSchema(E.GrievanceMessageType).default(E.GrievanceMessageType.PUBLIC_REPLY), attachmentUploadIds: z.array(z.string()).max(5).default([]), expectedVersion: z.number().int().positive().optional() });
export const handoverBody = z.object({ amountPaise: positivePaise, remarks: z.string().max(500).optional(), staffId: z.string().optional(), branchId: z.string().optional() });
export const redemptionBody = z.object({ mode: enumSchema(E.RedemptionMode), modeDetails: z.record(z.string(), z.unknown()).optional(), expectedVersion: z.number().int().positive() });
export const fixedSchemePayBody = z.object({
  amountPaise: positivePaise,
  redirectUrl: z.string().url().optional(),
  mobile: mobile.optional(),
});
export const publicPaymentInitiateBody = z.object({
  redirectUrl: z.string().url(),
  mobile: mobile.optional(),
});
export const uploadBody = z
  .object({
    purpose: enumSchema(E.UploadPurpose),
    fileName: z.string().min(1).max(255),
    contentType: z.string().min(1).max(120),
    sizeBytes: z.number().int().positive(),
  })
  .strict();
export const exportBody = z
  .object({
    type: enumSchema(E.ExportType),
    filters: z.record(z.string(), z.unknown()).default({}),
    format: z.enum(["CSV", "PDF"]).default("CSV"),
  })
  .strict();
