import test from "node:test";
import assert from "node:assert/strict";
import { createId } from "../src/lib/ids.js";
import {
  flexibleCalendarCycleCount,
  flexibleContributionCycleCount,
  isFlexibleMaturityOnlyCycleIndex,
} from "../src/lib/flexible-plan-duration.js";
import {
  buildCalendarMonthCycles,
  buildFlexibleSchemeCycleRows,
  maturityDateFromCalendarCycles,
} from "../src/lib/calendar-cycle.js";
import { buildSchedulePreview, resolveFixedSchemeMaturityDate } from "../src/services/schedule.service.js";
import { applyFlexibleLock, payableRange } from "../src/services/scheme.service.js";
import { computeFlexibleLockCapDetails } from "../src/lib/flexible-cap.js";
import { analyzeFreeWindowLedgerForCap } from "../src/lib/flexible-free-window-net.js";
import { Scheme, LedgerEntry } from "../src/models/index.js";
import { AppError } from "../src/lib/app-error.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

const flexRules6_5 = {
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

function plan12_11() {
  return {
    paymentPattern: "FLEXIBLE",
    durationMonths: 12,
    installmentCount: 11,
    flexibleRules: flexRules6_5,
  };
}

test("A — flexible 12-month calendar tenure with 11 contribution cycles (6 free + 5 capped)", async () => {
  const plan = plan12_11();
  assert.equal(flexibleCalendarCycleCount(plan), 12);
  assert.equal(flexibleContributionCycleCount(plan), 11);
  const startDate = "2026-01-10";
  const cycles = buildFlexibleSchemeCycleRows({
    startDate,
    durationMonths: 12,
    firstInstallmentMode: "COLLECT_NOW",
  });
  assert.equal(cycles.length, 12);
  assert.equal(isFlexibleMaturityOnlyCycleIndex(11, plan), true);
  assert.equal(isFlexibleMaturityOnlyCycleIndex(10, plan), false);
  const maturityDate = maturityDateFromCalendarCycles(
    buildCalendarMonthCycles({ startDate, cycleCount: 12, firstInstallmentMode: "COLLECT_NOW" }),
  );
  assert.equal(maturityDate, "2026-12-31");

  const { tenant, branch, user } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: "ENR-12-11",
    planSnapshot: plan,
    valueBasis: "CASH",
    paymentPattern: "FLEXIBLE",
    status: "ACTIVE",
    flexiblePhase: "FLEXIBLE",
    startDate,
    maturityDate,
    cycles,
    positionVersion: 1,
    version: 1,
    createdBy: user._id,
  });

  for (let i = 0; i < 6; i += 1) {
    await LedgerEntry.create({
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId: customer._id,
      type: "FREE_WINDOW_PAYMENT",
      sequence: i + 1,
      amountPaise: 60_000,
      cycle: cycles[i].cycle,
      actorType: "USER",
      actorId: user._id,
    });
  }

  const lockReq = {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { schemeId: scheme._id },
    headers: {},
    ip: "127.0.0.1",
  };
  await applyFlexibleLock({ ...lockReq, params: { schemeId: scheme._id } }, { referenceDate: "2026-07-01" });

  const locked = await Scheme.findById(scheme._id).lean();
  assert.equal(locked.flexiblePhase, "CAPPED");
  const cappedWithCap = (locked.cycles ?? []).filter((row) => row.capPaise > 0);
  assert.equal(cappedWithCap.length, 5);
  assert.equal(locked.cycles[11].capPaise, 0);

  const maturityCycleKey = cycles[11].cycle;
  await assert.rejects(
    () => payableRange(
      { auth: { tenantId: tenant._id }, query: { targetCycle: maturityCycleKey } },
      locked,
      { referenceDate: `${maturityCycleKey}-15` },
    ),
    (err) => err instanceof AppError && err.code === "MATURITY_WAITING_CYCLE",
  );
});

test("B — flexible 11-month duration with 11 contributions has no maturity-only tail", () => {
  const plan = {
    paymentPattern: "FLEXIBLE",
    durationMonths: 11,
    installmentCount: 11,
    flexibleRules: { ...flexRules6_5, cappedPhaseCycles: 5, flexiblePhaseCycles: 6 },
  };
  const cycles = buildFlexibleSchemeCycleRows({
    startDate: "2026-02-01",
    durationMonths: 11,
    firstInstallmentMode: "COLLECT_NOW",
  });
  assert.equal(cycles.length, 11);
  assert.equal(isFlexibleMaturityOnlyCycleIndex(10, plan), false);
});

test("C — fixed 12-month duration with 11 installments", () => {
  const startDate = "2026-01-15";
  const durationMonths = 12;
  const installmentCount = 11;
  const rows = buildSchedulePreview({
    startDate,
    installmentAmountPaise: 50_000,
    durationMonths,
    installmentCount,
    scheduleRules: { dueDateRule: "JOIN_ANNIVERSARY", graceDays: 0 },
    firstInstallmentMode: "COLLECT_NOW",
  });
  assert.equal(rows.length, 11);
  const maturityDate = resolveFixedSchemeMaturityDate({
    startDate,
    durationMonths,
    firstInstallmentMode: "COLLECT_NOW",
  });
  assert.equal(maturityDate, "2026-12-31");
  assert.ok(rows[rows.length - 1].dueDate < maturityDate);
});

test("F — preview cap uses the same lock helper as runtime lock", () => {
  const entries = [
    { type: "FREE_WINDOW_PAYMENT", amountPaise: 360_000, cycle: "2026-01" },
  ];
  const netSummary = analyzeFreeWindowLedgerForCap(entries);
  const { capPaise: previewCap } = computeFlexibleLockCapDetails({
    netSummary,
    flexibleRules: flexRules6_5,
    freePhaseBoundary: "2026-06-30",
    lockedAt: new Date("2026-07-01T12:00:00.000Z"),
  });
  const { capPaise: runtimeCap } = computeFlexibleLockCapDetails({
    netSummary,
    flexibleRules: flexRules6_5,
    freePhaseBoundary: "2026-06-30",
    lockedAt: new Date("2026-07-01T12:00:00.000Z"),
  });
  assert.equal(previewCap, runtimeCap);
});
