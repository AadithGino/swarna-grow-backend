import test from "node:test";
import assert from "node:assert/strict";
import { planBody } from "../src/validators/common.validators.js";
import { RedemptionMode } from "../src/constants/enums.js";

const planBase = {
  name: "Cross-field plan",
  code: "XFLD001",
  valueBasis: "CASH",
  paymentPattern: "FIXED",
  durationMonths: 12,
  installmentCount: 12,
  amountRules: { amountMode: "JEWELLER_FIXED", fixedAmountPaise: 100_000 },
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

test("valid fixed plan passes cross-field validation", () => {
  const parsed = planBody.safeParse(planBase);
  assert.equal(parsed.success, true);
});

test("fixed amount mode requires fixedAmountPaise", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "XFLD002",
    amountRules: { amountMode: "JEWELLER_FIXED" },
  });
  assert.equal(parsed.success, false);
});

test("slab mode requires slabsPaise", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "XFLD003",
    amountRules: { amountMode: "JEWELLER_SLABS", slabsPaise: [] },
  });
  assert.equal(parsed.success, false);
});

test("customer-chosen min cannot exceed max installment", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "XFLD004",
    amountRules: {
      amountMode: "CUSTOMER_CHOSEN",
      minInstallmentPaise: 200_000,
      maxInstallmentPaise: 100_000,
    },
  });
  assert.equal(parsed.success, false);
});

test("flexible phase min payment cannot exceed max payment", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "XFLD005",
    paymentPattern: "FLEXIBLE",
    amountRules: {
      amountMode: "CUSTOMER_CHOSEN",
      minInstallmentPaise: 10_000,
      maxInstallmentPaise: 500_000,
    },
    scheduleRules: { dueDateRule: "JOIN_ANNIVERSARY", firstInstallmentModeDefault: "COLLECT_NOW" },
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
        minimumPaymentPaise: 50_000,
        maximumPaymentPaise: 10_000,
        paymentIncrementPaise: 1_000,
      },
      capComputation: {
        formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
        roundingMode: "ROUND_UP",
        roundToNearestPaise: 10_000,
        minCycleCapPaise: 50_000,
        maxCycleCapPaise: 500_000,
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
  });
  assert.equal(parsed.success, false);
});

test("cap floor cannot exceed cap ceiling", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "XFLD006",
    paymentPattern: "FLEXIBLE",
    amountRules: {
      amountMode: "CUSTOMER_CHOSEN",
      minInstallmentPaise: 10_000,
      maxInstallmentPaise: 500_000,
    },
    scheduleRules: { dueDateRule: "JOIN_ANNIVERSARY", firstInstallmentModeDefault: "COLLECT_NOW" },
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
        maximumPaymentPaise: 500_000,
        paymentIncrementPaise: 1_000,
      },
      capComputation: {
        formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
        roundingMode: "ROUND_UP",
        roundToNearestPaise: 10_000,
        minCycleCapPaise: 500_000,
        maxCycleCapPaise: 50_000,
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
  });
  assert.equal(parsed.success, false);
});

test("allBranches false requires branchIds", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "XFLD007",
    availability: { ...planBase.availability, allBranches: false, branchIds: [] },
  });
  assert.equal(parsed.success, false);
});

test("enrolment open dates must be valid and ordered", () => {
  const badFormat = planBody.safeParse({
    ...planBase,
    code: "XFLD008",
    availability: { ...planBase.availability, enrolmentOpenFrom: "2026/01/01" },
  });
  assert.equal(badFormat.success, false);
  const inverted = planBody.safeParse({
    ...planBase,
    code: "XFLD009",
    availability: {
      ...planBase.availability,
      enrolmentOpenFrom: "2026-12-01",
      enrolmentOpenTo: "2026-01-01",
    },
  });
  assert.equal(inverted.success, false);
});

test("lockInMonths cannot exceed durationMonths", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "XFLD010",
    redemptionRules: { ...planBase.redemptionRules, lockInMonths: 24 },
  });
  assert.equal(parsed.success, false);
});

test("advance disabled requires zero maxAdvanceInstallments", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "XFLD011",
    paymentRules: {
      partialPaymentAllowed: false,
      minPaymentPaise: 100_000,
      advancePaymentAllowed: false,
      maxAdvanceInstallments: 2,
    },
  });
  assert.equal(parsed.success, false);
});

test("fixed bonus requires bonusBasis", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "XFLD012",
    benefit: {
      type: "FIXED_BONUS_AMOUNT",
      displayLabel: "Bonus",
      eligibility: planBase.benefit.eligibility,
    },
  });
  assert.equal(parsed.success, false);
});

test("percent penalty requires value 0-100", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "XFLD013",
    redemptionRules: {
      ...planBase.redemptionRules,
      prematureClosureAllowed: true,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 150, benefitTreatment: "FORFEIT" },
    },
  });
  assert.equal(parsed.success, false);
});
