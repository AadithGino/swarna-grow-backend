import test from "node:test";
import assert from "node:assert/strict";
import {
  computeFlexibleCycleCapPaise,
  flexibleCapDivisor,
} from "../src/lib/flexible-cap.js";

const baseRules = {
  flexiblePhaseCycles: 6,
  averagingDivisor: 6,
  flexiblePhase: { minTotalPaise: 0 },
  capComputation: {
    formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
    roundToNearestPaise: 10000,
    minCycleCapPaise: 50000,
    maxCycleCapPaise: 10000000,
    onBelowMinimumTotal: "USE_MINIMUM",
  },
};

test("averaging divisor spreads total over configured months", () => {
  assert.equal(flexibleCapDivisor(baseRules, 12), 6);
  assert.equal(
    computeFlexibleCycleCapPaise({
      totalPaise: 300000,
      freeWindowPaymentCount: 12,
      flexibleRules: baseRules,
    }),
    50000,
  );
});

test("floor and ceiling clamp computed cap", () => {
  const cap = computeFlexibleCycleCapPaise({
    totalPaise: 600000,
    freeWindowPaymentCount: 6,
    flexibleRules: {
      ...baseRules,
      capComputation: {
        ...baseRules.capComputation,
        minCycleCapPaise: 80000,
        maxCycleCapPaise: 90000,
      },
    },
  });
  assert.equal(cap, 90000);
});

test("exactly at minimum total uses normal formula when above minTotal", () => {
  const rules = {
    ...baseRules,
    flexiblePhase: { minTotalPaise: 300000 },
    capComputation: {
      ...baseRules.capComputation,
      onBelowMinimumTotal: "USE_MINIMUM",
    },
  };
  assert.equal(
    computeFlexibleCycleCapPaise({
      totalPaise: 300000,
      freeWindowPaymentCount: 6,
      flexibleRules: rules,
    }),
    50000,
  );
});

test("below minimum with USE_MINIMUM applies minCycleCapPaise", () => {
  const rules = {
    ...baseRules,
    flexiblePhase: { minTotalPaise: 500000 },
    capComputation: {
      ...baseRules.capComputation,
      minCycleCapPaise: 75000,
      onBelowMinimumTotal: "USE_MINIMUM",
    },
  };
  assert.equal(
    computeFlexibleCycleCapPaise({
      totalPaise: 200000,
      freeWindowPaymentCount: 4,
      flexibleRules: rules,
    }),
    75000,
  );
});

test("one lump-sum payment uses payment count of one as divisor", () => {
  const rules = {
    ...baseRules,
    capComputation: {
      ...baseRules.capComputation,
      formula: "FLEXIBLE_PHASE_TOTAL_DIV_PAYMENT_COUNT",
      roundToNearestPaise: 10000,
    },
  };
  assert.equal(
    computeFlexibleCycleCapPaise({
      totalPaise: 120000,
      freeWindowPaymentCount: 1,
      flexibleRules: rules,
    }),
    120000,
  );
});

test("payment count formula uses free-window payment entries", () => {
  const rules = {
    ...baseRules,
    capComputation: {
      ...baseRules.capComputation,
      formula: "FLEXIBLE_PHASE_TOTAL_DIV_PAYMENT_COUNT",
    },
  };
  assert.equal(flexibleCapDivisor(rules, 3), 3);
  assert.equal(
    computeFlexibleCycleCapPaise({
      totalPaise: 300000,
      freeWindowPaymentCount: 3,
      flexibleRules: rules,
    }),
    100000,
  );
});
