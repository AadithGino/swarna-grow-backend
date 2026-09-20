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
