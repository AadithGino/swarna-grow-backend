import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCalendarMonthCycles,
  buildFlexibleSchemeCycleRows,
  firstCalendarCycleMonthKey,
  fixedMaturityDateFromFinalDueDate,
  isFlexibleLockDueAfterFreePhase,
  maturityDateFromCalendarCycles,
} from "../src/lib/calendar-cycle.js";

test("COLLECT_NOW starts cycle 1 in enrolment month", () => {
  assert.equal(firstCalendarCycleMonthKey("2026-01-31", "COLLECT_NOW"), "2026-01");
  const cycles = buildCalendarMonthCycles({
    startDate: "2026-01-31",
    cycleCount: 3,
    firstInstallmentMode: "COLLECT_NOW",
  });
  assert.deepEqual(cycles.map((c) => c.cycle), ["2026-01", "2026-02", "2026-03"]);
  assert.equal(maturityDateFromCalendarCycles(cycles), "2026-03-31");
});

test("START_NEXT_CYCLE shifts first cycle to next calendar month", () => {
  const cycles = buildCalendarMonthCycles({
    startDate: "2026-01-31",
    cycleCount: 3,
    firstInstallmentMode: "START_NEXT_CYCLE",
  });
  assert.deepEqual(cycles.map((c) => c.cycle), ["2026-02", "2026-03", "2026-04"]);
  assert.equal(maturityDateFromCalendarCycles(cycles), "2026-04-30");
});

test("leap year February end dates", () => {
  const cycles = buildCalendarMonthCycles({
    startDate: "2024-01-15",
    cycleCount: 2,
    firstInstallmentMode: "COLLECT_NOW",
  });
  assert.equal(cycles[1].expiresAt, "2024-02-29");
});

test("December to January year rollover", () => {
  const cycles = buildCalendarMonthCycles({
    startDate: "2025-12-20",
    cycleCount: 2,
    firstInstallmentMode: "COLLECT_NOW",
  });
  assert.deepEqual(cycles.map((c) => c.cycle), ["2025-12", "2026-01"]);
  assert.equal(cycles[1].expiresAt, "2026-01-31");
});

test("fixed maturity uses last day of final due month", () => {
  assert.equal(fixedMaturityDateFromFinalDueDate("2027-08-10"), "2027-08-31");
});

test("flexible scheme cycles use calendar month expiry", () => {
  const rows = buildFlexibleSchemeCycleRows({
    startDate: "2026-03-05",
    durationMonths: 2,
    firstInstallmentMode: "COLLECT_NOW",
  });
  assert.deepEqual(rows.map((r) => r.cycle), ["2026-03", "2026-04"]);
  assert.equal(rows[0].expiresAt, "2026-03-31");
  assert.equal(rows[1].expiresAt, "2026-04-30");
});

test("flexible lock waits until after last free calendar cycle", () => {
  const rows = buildFlexibleSchemeCycleRows({
    startDate: "2026-01-10",
    durationMonths: 4,
    firstInstallmentMode: "COLLECT_NOW",
  });
  assert.equal(isFlexibleLockDueAfterFreePhase("2026-02-28", rows, 2), false);
  assert.equal(isFlexibleLockDueAfterFreePhase("2026-03-01", rows, 2), true);
});
