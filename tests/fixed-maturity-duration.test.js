import test from "node:test";
import assert from "node:assert/strict";
import {
  fixedMaturityDateFromDuration,
  maturityDateFromCalendarCycles,
  buildCalendarMonthCycles,
} from "../src/lib/calendar-cycle.js";
import { buildSchedulePreview, resolveFixedSchemeMaturityDate } from "../src/services/schedule.service.js";
import { SchemeStatus } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { Scheme } from "../src/models/index.js";
import { runMaturityTransitionBatch } from "../src/services/scheme-maintenance.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("12-month duration with 11 installments matures at calendar month 12", () => {
  const startDate = "2026-01-15";
  const durationMonths = 12;
  const installmentCount = 11;
  const firstInstallmentMode = "COLLECT_NOW";
  const rows = buildSchedulePreview({
    startDate,
    installmentAmountPaise: 100_000,
    durationMonths,
    installmentCount,
    scheduleRules: { dueDateRule: "JOIN_ANNIVERSARY", graceDays: 0 },
    firstInstallmentMode,
  });
  assert.equal(rows.length, 11);
  const maturityDate = resolveFixedSchemeMaturityDate({
    startDate,
    durationMonths,
    firstInstallmentMode,
  });
  assert.equal(maturityDate, "2026-12-31");
  assert.ok(rows[rows.length - 1].dueDate < maturityDate);
});

test("12-month duration with 12 installments shares the same maturity date", () => {
  const startDate = "2026-01-15";
  const durationMonths = 12;
  const firstInstallmentMode = "START_NEXT_CYCLE";
  const maturityDate = fixedMaturityDateFromDuration({
    startDate,
    durationMonths,
    firstInstallmentMode,
  });
  const cycles = buildCalendarMonthCycles({
    startDate,
    cycleCount: durationMonths,
    firstInstallmentMode,
  });
  assert.equal(maturityDate, maturityDateFromCalendarCycles(cycles));
  assert.equal(maturityDate, "2027-01-31");
});

test("month-end enrolment COLLECT_NOW uses final calendar month end", () => {
  const maturityDate = fixedMaturityDateFromDuration({
    startDate: "2026-01-31",
    durationMonths: 3,
    firstInstallmentMode: "COLLECT_NOW",
  });
  assert.equal(maturityDate, "2026-03-31");
});

test("maturity job does not transition before maturityDate", async () => {
  const { tenant, branch } = await seedTenantUser();
  await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    planId: createId("schemePlan"),
    enrollmentNumber: "ENR-MAT-FUT",
    planSnapshot: { paymentPattern: "FIXED", durationMonths: 12 },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: SchemeStatus.ACTIVE,
    startDate: "2026-01-01",
    maturityDate: "2026-12-31",
    installments: [],
  });
  const batch = await runMaturityTransitionBatch({ today: "2026-06-15" });
  assert.equal(batch.processed, 0);
  const row = await Scheme.findOne({ enrollmentNumber: "ENR-MAT-FUT" }).lean();
  assert.equal(row.status, SchemeStatus.ACTIVE);
});

test("maturity job transitions on or after maturityDate when instalments are complete", async () => {
  const { tenant, branch } = await seedTenantUser();
  const installments = Array.from({ length: 6 }, (_, index) => ({
    number: index + 1,
    dueDate: `2026-${String(index + 1).padStart(2, "0")}-01`,
    amountPaise: 100_000,
    paidPaise: 100_000,
    status: "PAID",
    graceEndsAt: `2026-${String(index + 1).padStart(2, "0")}-05`,
  }));
  await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    planId: createId("schemePlan"),
    enrollmentNumber: "ENR-MAT-DUE",
    planSnapshot: { paymentPattern: "FIXED" },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: SchemeStatus.ACTIVE,
    startDate: "2026-01-01",
    maturityDate: "2026-06-30",
    installments,
  });
  const batch = await runMaturityTransitionBatch({ today: "2026-07-01" });
  assert.equal(batch.processed, 1);
});
