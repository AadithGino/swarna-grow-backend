import test from "node:test";
import assert from "node:assert/strict";
import { payableRange } from "../src/services/scheme.service.js";
import { planBody } from "../src/validators/common.validators.js";
import { monthKey } from "../src/lib/date.js";

const req = (targetCycle, body = {}) => ({ query: { targetCycle }, body, auth: { tenantId: "tnt_1", type: "CUSTOMER", id: "cus_1" } });
const currentCycle = monthKey();
function shiftMonth(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
const nextCycle = shiftMonth(currentCycle, 1);
const cyclePlus2 = shiftMonth(currentCycle, 2);
const cyclePlus3 = shiftMonth(currentCycle, 3);

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
    amountRules: {
      amountMode: "CUSTOMER_CHOSEN",
      slabsPaise: [],
      minInstallmentPaise: 100_000,
      maxInstallmentPaise: 2_500_000,
      multipleOfPaise: 10_000,
    },
    scheduleRules: { dueDateRule: "JOIN_ANNIVERSARY", firstInstallmentModeDefault: "START_NEXT_CYCLE" },
    paymentRules: { partialPaymentAllowed: true, minPaymentPaise: 100_000 },
    flexibleRules: { phaseMode: "FLEXIBLE_THEN_CAPPED", capMode: "FLEXIBLE_PHASE_AVERAGE", carryForwardMode: "NONE", flexiblePhaseCycles: 6, cappedPhaseCycles: 5, averagingDivisor: 6, frequencyMode: "MULTIPLE", extensionMode: "EXTEND_FLEXIBLE_PHASE", flexiblePhase: { minimumPaymentPaise: 100000, maximumPaymentPaise: 2500000, paymentIncrementPaise: 10000, minTotalPaise: 300000, maxPaymentsPerCycle: null, paymentsRequiredPerCycle: 0 }, capComputation: { formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR", roundingMode: "ROUND_UP", roundToNearestPaise: 10000, minCycleCapPaise: 50000, maxCycleCapPaise: 10000000, onZeroFlexiblePhaseTotal: "CLOSE_SCHEME", onBelowMinimumTotal: "USE_MINIMUM" }, cappedPhase: { minimumPaymentPaise: 100000, paymentIncrementPaise: 10000, allowFinalRemainderBelowMinimum: true, allowFutureCyclePayment: false, maxAdvanceCycles: 0 } },
    redemptionRules: { prematureClosureAllowed: true, lockInMonths: 3, prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" }, allowedModes: ["CASH"], redeemAtAnyBranch: false }, availability: { allBranches: true, branchIds: [], visibleInCustomerApp: true, customerSelfEnrolAllowed: true },
    benefit: {
      type: "TEXT_ONLY",
      displayLabel: "Gift",
      eligibility: { requireAllInstallmentsPaid: true, maxAllowedDefaults: 0, minMonthsCompleted: 0 },
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.data.flexibleRules.extensionMode, "EXTEND_FLEXIBLE_PHASE");
});

function futureScheme({ allowFuture = true, maxAdvance = 2, currentRemaining = 0, nextRemaining = 250000, plus2Remaining = 300000 } = {}) {
  return {
    _id: "sch_future", tenantId: "tnt_1", customerId: "cus_1", status: "LOCKED", paymentPattern: "FLEXIBLE", flexiblePhase: "CAPPED", positionVersion: 0,
    cycles: [
      { cycle: currentCycle, capPaise: 250000, paidPaise: 250000 - currentRemaining, remainingPaise: currentRemaining, status: currentRemaining ? "PARTIALLY_PAID" : "PAID" },
      { cycle: nextCycle, capPaise: 250000, paidPaise: 250000 - nextRemaining, remainingPaise: nextRemaining, status: nextRemaining ? (nextRemaining < 250000 ? "PARTIALLY_PAID" : "UPCOMING") : "PAID" },
      { cycle: cyclePlus2, capPaise: 300000, paidPaise: 300000 - plus2Remaining, remainingPaise: plus2Remaining, status: plus2Remaining ? "UPCOMING" : "PAID" },
      { cycle: cyclePlus3, capPaise: 300000, paidPaise: 0, remainingPaise: 300000, status: "UPCOMING" },
    ],
    planSnapshot: { flexibleRules: { cappedPhase: { minimumPaymentPaise: 100000, paymentIncrementPaise: 10000, allowFinalRemainderBelowMinimum: true, allowFutureCyclePayment: allowFuture, maxAdvanceCycles: maxAdvance } } },
  };
}

test("future cycle rejects when allowFutureCyclePayment is false", async () => {
  await assert.rejects(() => payableRange(req(nextCycle), futureScheme({ allowFuture: false })), (error) => error.code === "FUTURE_CYCLE_PAYMENT_NOT_ALLOWED");
});

test("future cycle rejects when current cycle still has remainingPaise", async () => {
  await assert.rejects(() => payableRange(req(nextCycle), futureScheme({ currentRemaining: 50000 })), (error) => error.code === "CURRENT_CYCLE_INCOMPLETE");
});

test("future cycle rejects when an intermediate cycle still has remaining allowance", async () => {
  await assert.rejects(() => payableRange(req(cyclePlus2), futureScheme({ nextRemaining: 10000 })), (error) => error.code === "CYCLE_SEQUENCE_VIOLATION");
});

test("future cycle rejects when monthDistance exceeds maxAdvanceCycles", async () => {
  await assert.rejects(() => payableRange(req(cyclePlus3), futureScheme({ maxAdvance: 2, nextRemaining: 0, plus2Remaining: 0 })), (error) => error.code === "ADVANCE_CYCLE_LIMIT_EXCEEDED");
});

test("future cycle happy path quotes the target cycle's own cap", async () => {
  const quote = await payableRange(req(nextCycle), futureScheme());
  assert.equal(quote.payable, true);
  assert.equal(quote.targetCycle, nextCycle);
  assert.equal(quote.maxPayablePaise, 250000);
  assert.equal(quote.capPaise, 250000);
});
