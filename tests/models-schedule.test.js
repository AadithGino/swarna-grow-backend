import test from "node:test";
import assert from "node:assert/strict";
import { Payment, SchemePlan } from "../src/models/index.js";
import { buildSchedulePreview } from "../src/services/schedule.service.js";

test("fixed schedule clamps dates and creates deterministic installments", () => {
  const rows = buildSchedulePreview({ startDate: "2026-01-31", installmentAmountPaise: 300000, installmentCount: 3, durationMonths: 3, scheduleRules: { dueDateRule: "JOIN_ANNIVERSARY", graceDays: 5 } });
  assert.deepEqual(rows.map((row) => row.dueDate), ["2026-01-31", "2026-02-28", "2026-03-31"]);
  assert.equal(rows[1].amountPaise, 300000);
});

test("models accept pending gateway attempts and reject unknown payment statuses", async () => {
  const valid = new Payment({ tenantId: "tnt_1", branchId: "brn_1", schemeId: "sch_1", customerId: "cus_1", receiptNumber: "PENDING-pmi_1", amountPaise: 60000, mode: "ONLINE_GATEWAY", status: "PENDING", source: "CUSTOMER_APP" });
  await valid.validate();
  valid.status = "MADE_UP";
  await assert.rejects(valid.validate(), /not a valid enum value/);
});

test("flexible plan model enforces enum-backed rule blocks", async () => {
  const plan = new SchemePlan({ tenantId: "tnt_1", name: "Flexible", code: "FLEX", valueBasis: "CASH", paymentPattern: "FLEXIBLE", durationMonths: 11, installmentCount: 11, amountRules: { amountMode: "CUSTOMER_CHOSEN" }, scheduleRules: { dueDateRule: "JOIN_ANNIVERSARY", firstInstallmentModeDefault: "START_NEXT_CYCLE" }, flexibleRules: { phaseMode: "FLEXIBLE_THEN_CAPPED", capMode: "FLEXIBLE_PHASE_AVERAGE", carryForwardMode: "NONE", flexiblePhaseCycles: 6, cappedPhaseCycles: 5, averagingDivisor: 6, frequencyMode: "MULTIPLE", flexiblePhase: { minimumPaymentPaise: 100000, maximumPaymentPaise: 2500000, paymentIncrementPaise: 10000, minTotalPaise: 300000, paymentsRequiredPerCycle: 0 }, capComputation: { formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR", roundingMode: "ROUND_UP", roundToNearestPaise: 10000, minCycleCapPaise: 50000, maxCycleCapPaise: 10000000, onZeroFlexiblePhaseTotal: "CLOSE_SCHEME", onBelowMinimumTotal: "USE_MINIMUM" }, cappedPhase: { minimumPaymentPaise: 100000, paymentIncrementPaise: 10000, allowFinalRemainderBelowMinimum: true, allowFutureCyclePayment: false, maxAdvanceCycles: 0 } }, redemptionRules: { prematureClosureAllowed: true, lockInMonths: 3, prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" }, allowedModes: ["CASH"], redeemAtAnyBranch: false }, availability: { allBranches: true, branchIds: [] } });
  await plan.validate();
  plan.flexibleRules.carryForwardMode = "ROLL_OVER";
  await assert.rejects(plan.validate(), /not a valid enum value/);
});

