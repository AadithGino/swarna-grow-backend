import test from "node:test";
import assert from "node:assert/strict";
import { planBody } from "../src/validators/common.validators.js";
import {
  flexiblePhaseCyclesValid,
  flexiblePhaseTargetMonths,
} from "../src/lib/flexible-plan-duration.js";

const flexibleRules6_5 = {
  phaseMode: "FLEXIBLE_THEN_CAPPED",
  capMode: "FLEXIBLE_PHASE_AVERAGE",
  carryForwardMode: "NONE",
  flexiblePhaseCycles: 6,
  cappedPhaseCycles: 5,
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
};

test("flexiblePhaseTargetMonths prefers installmentCount", () => {
  assert.equal(
    flexiblePhaseTargetMonths({ durationMonths: 12, installmentCount: 11 }),
    11,
  );
});

test("flexible plan accepts 12-month duration with 11 payment months (6+5 phases)", () => {
  const parsed = planBody.safeParse({
    name: "Flex 12/11",
    code: "FX1211",
    valueBasis: "CASH",
    paymentPattern: "FLEXIBLE",
    durationMonths: 12,
    installmentCount: 11,
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
    flexibleRules: flexibleRules6_5,
    redemptionRules: {
      prematureClosureAllowed: false,
      lockInMonths: 0,
      prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
      allowedModes: ["CASH"],
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
      displayLabel: "Store benefit",
      eligibility: {
        requireAllInstallmentsPaid: true,
        maxAllowedDefaults: 0,
        minMonthsCompleted: 0,
      },
    },
  });
  assert.equal(parsed.success, true);
  assert.equal(flexiblePhaseCyclesValid(parsed.data), true);
});

test("flexible plan rejects when phases sum to duration but not installmentCount", () => {
  const parsed = planBody.safeParse({
    name: "Flex bad sum",
    code: "FXBADSUM",
    valueBasis: "CASH",
    paymentPattern: "FLEXIBLE",
    durationMonths: 12,
    installmentCount: 11,
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
    flexibleRules: { ...flexibleRules6_5, cappedPhaseCycles: 6 },
    redemptionRules: {
      prematureClosureAllowed: false,
      lockInMonths: 0,
      prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
      allowedModes: ["CASH"],
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
      displayLabel: "Store benefit",
      eligibility: {
        requireAllInstallmentsPaid: true,
        maxAllowedDefaults: 0,
        minMonthsCompleted: 0,
      },
    },
  });
  assert.equal(parsed.success, false);
});
