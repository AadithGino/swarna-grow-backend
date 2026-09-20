import test from "node:test";
import assert from "node:assert/strict";
import {
  goldRateBody,
  planBody,
  redemptionBody,
  tenantOperationsPatchBody,
} from "../src/validators/common.validators.js";
import { PlanTier, RedemptionMode, TenantRole } from "../src/constants/enums.js";
import { SchemePlan, Tenant } from "../src/models/index.js";
import { setGoldRate } from "../src/services/tenant.service.js";
import { createPlan } from "../src/services/plan.service.js";
import { AppError } from "../src/lib/app-error.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

const planBase = {
  name: "Validation plan",
  code: "VALPLAN1",
  valueBasis: "CASH",
  paymentPattern: "FIXED",
  durationMonths: 12,
  installmentCount: 12,
  amountRules: { amountMode: "FIXED", fixedAmountPaise: 100_000 },
  scheduleRules: {
    dueDateRule: "FIXED_DAY_OF_MONTH",
    dueDayOfMonth: 5,
    firstInstallmentModeDefault: "START_NEXT_CYCLE",
  },
  paymentRules: { partialPaymentAllowed: false, minPaymentPaise: 100_000 },
  redemptionRules: {
    prematureClosureAllowed: false,
    lockInMonths: 0,
    prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
    allowedModes: [RedemptionMode.CASH],
    redeemAtAnyBranch: false,
  },
  availability: {
    allBranches: true,
    branchIds: [],
    visibleInCustomerApp: true,
    customerSelfEnrolAllowed: true,
  },
  benefit: {
    type: "TEXT_ONLY",
    displayLabel: "Gift voucher",
    eligibility: {
      requireAllInstallmentsPaid: true,
      maxAllowedDefaults: 0,
      minMonthsCompleted: 0,
    },
  },
};

test("flexible plan rejects when phase cycles do not sum to durationMonths", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "FLEXBAD",
    paymentPattern: "FLEXIBLE",
    amountRules: {
      amountMode: "CUSTOMER_CHOSEN",
      minInstallmentPaise: 10_000,
      maxInstallmentPaise: 2_500_000,
      multipleOfPaise: 1_000,
    },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      firstInstallmentModeDefault: "COLLECT_NOW",
    },
    paymentRules: { partialPaymentAllowed: true, minPaymentPaise: 10_000 },
    flexibleRules: {
      phaseMode: "FLEXIBLE_THEN_CAPPED",
      capMode: "FLEXIBLE_PHASE_AVERAGE",
      carryForwardMode: "NONE",
      flexiblePhaseCycles: 6,
      cappedPhaseCycles: 4,
      averagingDivisor: 6,
      frequencyMode: "MULTIPLE",
      flexiblePhase: {
        minimumPaymentPaise: 10_000,
        maximumPaymentPaise: 2_500_000,
        paymentIncrementPaise: 1_000,
        minTotalPaise: 0,
        paymentsRequiredPerCycle: 0,
      },
      capComputation: {
        formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
        roundingMode: "ROUND_UP",
        roundToNearestPaise: 10_000,
        minCycleCapPaise: 50_000,
        maxCycleCapPaise: 10_000_000,
        onZeroFlexiblePhaseTotal: "CLOSE_SCHEME",
        onBelowMinimumTotal: "USE_MINIMUM",
      },
      cappedPhase: {
        minimumPaymentPaise: 10_000,
        paymentIncrementPaise: 1_000,
        allowFinalRemainderBelowMinimum: true,
        allowFutureCyclePayment: false,
        maxAdvanceCycles: 0,
      },
    },
    durationMonths: 12,
  });
  assert.equal(parsed.success, false);
  assert.ok(
    parsed.error?.issues.some((issue) => issue.path.join(".") === "flexibleRules"),
  );
});

function flexiblePlanForCapValidation(roundingMode) {
  return {
    ...planBase,
    code: `FXCAP${roundingMode.slice(0, 3)}`,
    paymentPattern: "FLEXIBLE",
    durationMonths: 12,
    installmentCount: 12,
    amountRules: {
      amountMode: "CUSTOMER_CHOSEN",
      minInstallmentPaise: 10_000,
      maxInstallmentPaise: 2_500_000,
      multipleOfPaise: 1_000,
    },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      firstInstallmentModeDefault: "COLLECT_NOW",
    },
    paymentRules: { partialPaymentAllowed: true, minPaymentPaise: 10_000 },
    flexibleRules: {
      phaseMode: "FLEXIBLE_THEN_CAPPED",
      capMode: "FLEXIBLE_PHASE_AVERAGE",
      carryForwardMode: "NONE",
      flexiblePhaseCycles: 6,
      cappedPhaseCycles: 6,
      averagingDivisor: 6,
      frequencyMode: "MULTIPLE",
      flexiblePhase: {
        minimumPaymentPaise: 10_000,
        maximumPaymentPaise: 2_500_000,
        paymentIncrementPaise: 1_000,
        minTotalPaise: 0,
        paymentsRequiredPerCycle: 0,
      },
      capComputation: {
        formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
        roundingMode,
        roundToNearestPaise: 10_000,
        minCycleCapPaise: 50_000,
        maxCycleCapPaise: 10_000_000,
        onZeroFlexiblePhaseTotal: "CLOSE_SCHEME",
        onBelowMinimumTotal: "USE_MINIMUM",
      },
      cappedPhase: {
        minimumPaymentPaise: 10_000,
        paymentIncrementPaise: 1_000,
        allowFinalRemainderBelowMinimum: true,
        allowFutureCyclePayment: false,
        maxAdvanceCycles: 0,
      },
    },
  };
}

test("planBody rejects ROUND_DOWN flexible cap rounding mode", () => {
  const parsed = planBody.safeParse(flexiblePlanForCapValidation("ROUND_DOWN"));
  assert.equal(parsed.success, false);
  assert.ok(
    parsed.error?.issues.some((issue) => issue.path.join(".").includes("roundingMode")),
  );
});

test("planBody rejects HALF_UP flexible cap rounding mode", () => {
  const parsed = planBody.safeParse(flexiblePlanForCapValidation("HALF_UP"));
  assert.equal(parsed.success, false);
});

test("createPlan service rejects ROUND_DOWN before Mongoose persistence", async () => {
  const { tenant, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await Tenant.updateOne({ _id: tenant._id }, { $set: { "subscription.tier": PlanTier.GROWTH } });
  const tenantRow = await Tenant.findById(tenant._id).lean();
  const body = flexiblePlanForCapValidation("ROUND_DOWN");
  await assert.rejects(
    () => createPlan({
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
      tenant: tenantRow,
      headers: { "user-agent": "test" },
      ip: "127.0.0.1",
      body,
    }),
    (error) => error instanceof AppError && error.code === "VALIDATION_FAILED",
  );
  assert.equal(await SchemePlan.countDocuments({ tenantId: tenant._id }), 0);
});

test("plan validation rejects PRORATE benefit treatment enum", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "FXPRORATE",
    redemptionRules: {
      ...planBase.redemptionRules,
      prematureClosureAllowed: true,
      prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "PRORATE" },
    },
  });
  assert.equal(parsed.success, false);
});

test("plan validation rejects TRANSFER_TO_SCHEME in allowedModes", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "FXTRANS",
    redemptionRules: {
      ...planBase.redemptionRules,
      allowedModes: ["TRANSFER_TO_SCHEME"],
    },
  });
  assert.equal(parsed.success, false);
});

test("redemption body rejects removed transfer mode", () => {
  const parsed = redemptionBody.safeParse({
    mode: "TRANSFER_TO_SCHEME",
    expectedVersion: 1,
  });
  assert.equal(parsed.success, false);
});

test("tenant operations patch rejects non-22K goldPurity", () => {
  const parsed = tenantOperationsPatchBody.safeParse({
    expectedVersion: 1,
    goldPurity: "24K",
  });
  assert.equal(parsed.success, false);
});

test("gold rate body rejects non-22K purity", () => {
  const parsed = goldRateBody.safeParse({
    effectiveDate: "2026-04-01",
    ratePerGramPaise: 500_000,
    purity: "18K",
  });
  assert.equal(parsed.success, false);
});

test("setGoldRate service rejects non-22K purity", async () => {
  const { tenant, user } = await seedTenantUser();
  await assert.rejects(
    () => setGoldRate({
      auth: { id: user._id, tenantId: tenant._id },
      body: {
        effectiveDate: "2026-04-01",
        ratePerGramPaise: 500_000,
        purity: "24K",
      },
    }),
    (error) => error instanceof AppError && error.code === "GOLD_PURITY_NOT_SUPPORTED",
  );
});

test("patchSettingsOperations rejects non-22K goldPurity via route schema", async () => {
  const { tenant, user } = await seedTenantUser();
  const parsed = tenantOperationsPatchBody.safeParse({
    expectedVersion: tenant.version,
    goldPurity: "18K",
  });
  assert.equal(parsed.success, false);
  assert.ok(user._id);
});
