import test from "node:test";
import assert from "node:assert/strict";
import { payableRange } from "../src/services/scheme.service.js";
import { planBody } from "../src/validators/common.validators.js";
import { monthKey } from "../src/lib/date.js";

const req = (targetCycle, body = {}) => ({ query: { targetCycle }, body, auth: { tenantId: "tnt_1", type: "CUSTOMER", id: "cus_1" } });
const currentCycle = monthKey();
const baseScheme = {
  _id: "sch_1", tenantId: "tnt_1", customerId: "cus_1", status: "LOCKED", paymentPattern: "FLEXIBLE", flexiblePhase: "CAPPED", positionVersion: 7,
  cycles: [{ cycle: currentCycle, capPaise: 250000, paidPaise: 190000, remainingPaise: 60000, status: "PARTIALLY_PAID" }],
  planSnapshot: { flexibleRules: { cappedPhase: { minimumPaymentPaise: 100000, paymentIncrementPaise: 10000, allowFinalRemainderBelowMinimum: true, allowFutureCyclePayment: false, maxAdvanceCycles: 0 } } },
};

test("capped flexible amount is an optional non-carrying allowance", async () => {
  const quote = await payableRange(req(currentCycle), baseScheme);
  assert.equal(quote.contributionIsOptional, true);
  assert.equal(quote.unusedAllowanceCarriesForward, false);
  assert.equal(quote.maxPayablePaise, 60000);
  assert.equal(quote.minPayablePaise, 60000);
  assert.equal(quote.positionVersion, 7);
});

test("unsupported flexible extension is recognized for explicit service rejection", () => {
  const result = planBody.safeParse({
    name: "Flexible", code: "FLEX_1", valueBasis: "CASH", paymentPattern: "FLEXIBLE", durationMonths: 11, installmentCount: 11,
    amountRules: { amountMode: "CUSTOMER_CHOSEN", slabsPaise: [] }, scheduleRules: { dueDateRule: "JOIN_ANNIVERSARY", firstInstallmentModeDefault: "START_NEXT_CYCLE" }, paymentRules: {},
    flexibleRules: { phaseMode: "FLEXIBLE_THEN_CAPPED", capMode: "FLEXIBLE_PHASE_AVERAGE", carryForwardMode: "NONE", flexiblePhaseCycles: 6, cappedPhaseCycles: 5, averagingDivisor: 6, frequencyMode: "MULTIPLE", extensionMode: "EXTEND_FLEXIBLE_PHASE", flexiblePhase: { minimumPaymentPaise: 100000, maximumPaymentPaise: 2500000, paymentIncrementPaise: 10000, minTotalPaise: 300000, maxPaymentsPerCycle: null, paymentsRequiredPerCycle: 0 }, capComputation: { formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR", roundingMode: "ROUND_UP", roundToNearestPaise: 10000, minCycleCapPaise: 50000, maxCycleCapPaise: 10000000, onZeroFlexiblePhaseTotal: "CLOSE_SCHEME", onBelowMinimumTotal: "USE_MINIMUM" }, cappedPhase: { minimumPaymentPaise: 100000, paymentIncrementPaise: 10000, allowFinalRemainderBelowMinimum: true, allowFutureCyclePayment: false, maxAdvanceCycles: 0 } },
    redemptionRules: { prematureClosureAllowed: true, lockInMonths: 3, prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" }, allowedModes: ["CASH"], redeemAtAnyBranch: false }, availability: { allBranches: true, branchIds: [], visibleInCustomerApp: true, customerSelfEnrolAllowed: true },
  });
  assert.equal(result.success, true);
  assert.equal(result.data.flexibleRules.extensionMode, "EXTEND_FLEXIBLE_PHASE");
});
