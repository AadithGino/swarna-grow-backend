import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFlexibleSchemeCycleRows,
  isFlexibleLockDueAfterFreePhase,
} from "../src/lib/calendar-cycle.js";
import { resetCalendarDateOverrideForTests, setCalendarDateOverrideForTests } from "../src/lib/date.js";
import { applyFlexibleLock } from "../src/services/scheme.service.js";
import { AuditEvent, LedgerEntry, Scheme, SchemePlan } from "../src/models/index.js";
import { FlexiblePhase, SchemeStatus, TenantRole } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  resetCalendarDateOverrideForTests();
});
test.afterEach(() => { resetCalendarDateOverrideForTests(); });

const flexRules = {
  flexiblePhaseCycles: 2,
  cappedPhaseCycles: 2,
  averagingDivisor: 2,
  flexiblePhase: { minTotalPaise: 0 },
  capComputation: {
    formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
    roundToNearestPaise: 1000,
    minCycleCapPaise: 20000,
    maxCycleCapPaise: 500000,
    onZeroFlexiblePhaseTotal: "USE_MINIMUM",
    onBelowMinimumTotal: "USE_MINIMUM",
  },
};

async function seedLockScheme({ startDate, durationMonths = 4, ledgerAmountPaise = 200_000 } = {}) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const planId = createId("schemePlan");
  await SchemePlan.create({
    _id: planId,
    tenantId: tenant._id,
    code: "FLXB",
    name: "Flex boundary",
    status: "ACTIVE",
    paymentPattern: "FLEXIBLE",
    valueBasis: "CASH",
    durationMonths,
    installmentCount: durationMonths,
    flexibleRules: flexRules,
  });
  const cycles = buildFlexibleSchemeCycleRows({
    startDate,
    durationMonths,
    firstInstallmentMode: "COLLECT_NOW",
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId,
    enrollmentNumber: `ENR-BND-${Date.now()}`,
    planSnapshot: { paymentPattern: "FLEXIBLE", flexibleRules: flexRules },
    valueBasis: "CASH",
    paymentPattern: "FLEXIBLE",
    flexiblePhase: FlexiblePhase.FLEXIBLE,
    status: SchemeStatus.ACTIVE,
    startDate,
    maturityDate: cycles[cycles.length - 1].expiresAt,
    cycles,
    version: 1,
    createdBy: user._id,
  });
  await LedgerEntry.create({
    _id: createId("ledger"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    sequence: 1,
    type: "FREE_WINDOW_PAYMENT",
    paymentId: "pay_boundary",
    amountPaise: ledgerAmountPaise,
    actorType: "USER",
    actorId: user._id,
  });
  const lockReq = () => ({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { schemeId: scheme._id },
    headers: {},
    ip: "127.0.0.1",
  });
  const lockOn = async (referenceDate) => {
    setCalendarDateOverrideForTests(referenceDate);
    return applyFlexibleLock(lockReq());
  };
  return { scheme, lockReq, lockOn, cycles };
}

test("lock rejected one day before free phase ends", async () => {
  const { lockReq, cycles } = await seedLockScheme({ startDate: "2026-01-10" });
  const lastFreeExpires = cycles[1].expiresAt;
  const dayBefore = "2026-02-27";
  assert.equal(lastFreeExpires, "2026-02-28");
  assert.equal(isFlexibleLockDueAfterFreePhase(dayBefore, cycles, 2), false);
  assert.equal(isFlexibleLockDueAfterFreePhase("2026-02-28", cycles, 2), false);
  setCalendarDateOverrideForTests(dayBefore);
  await assert.rejects(
    () => applyFlexibleLock(lockReq()),
    (error) => error.code === "FLEXIBLE_LOCK_NOT_DUE",
  );
});

test("lock rejected on final calendar day of last free cycle", async () => {
  const { lockReq, cycles } = await seedLockScheme({ startDate: "2026-01-10" });
  const lastDay = cycles[1].expiresAt;
  assert.equal(isFlexibleLockDueAfterFreePhase(lastDay, cycles, 2), false);
  setCalendarDateOverrideForTests(lastDay);
  await assert.rejects(
    () => applyFlexibleLock(lockReq()),
    (error) => error.code === "FLEXIBLE_LOCK_NOT_DUE",
  );
});

test("lock accepted on first day after free phase ends", async () => {
  const { lockOn, cycles } = await seedLockScheme({ startDate: "2026-01-10" });
  const firstEligible = "2026-03-01";
  assert.equal(isFlexibleLockDueAfterFreePhase(firstEligible, cycles, 2), true);
  const locked = await lockOn(firstEligible);
  assert.equal(locked.status, SchemeStatus.LOCKED);
  assert.equal(locked.flexiblePhase, FlexiblePhase.CAPPED);
});

test("February leap-year free phase boundary matches scheduler helper", async () => {
  const cycles = buildFlexibleSchemeCycleRows({
    startDate: "2024-01-15",
    durationMonths: 4,
    firstInstallmentMode: "COLLECT_NOW",
  });
  assert.equal(cycles[1].expiresAt, "2024-02-29");
  assert.equal(isFlexibleLockDueAfterFreePhase("2024-02-29", cycles, 2), false);
  assert.equal(isFlexibleLockDueAfterFreePhase("2024-03-01", cycles, 2), true);
});

test("manual admin lock cannot bypass FLEXIBLE_LOCK_NOT_DUE", async () => {
  const { lockReq } = await seedLockScheme({ startDate: "2026-01-10" });
  setCalendarDateOverrideForTests("2026-02-15");
  await assert.rejects(
    () => applyFlexibleLock(lockReq()),
    (error) => error.code === "FLEXIBLE_LOCK_NOT_DUE",
  );
});

test("request body lockReferenceDate cannot force early lock", async () => {
  const { lockReq } = await seedLockScheme({ startDate: "2026-01-10" });
  setCalendarDateOverrideForTests("2026-02-15");
  const req = lockReq();
  req.body = { lockReferenceDate: "2030-01-01" };
  req.query = { lockReferenceDate: "2030-01-01" };
  await assert.rejects(
    () => applyFlexibleLock(req),
    (error) => error.code === "FLEXIBLE_LOCK_NOT_DUE",
  );
});

test("repeat lock after success is idempotent on audit", async () => {
  const { scheme, lockOn } = await seedLockScheme({ startDate: "2020-01-01", durationMonths: 4 });
  await lockOn("2025-01-01");
  setCalendarDateOverrideForTests("2025-01-01");
  await assert.rejects(
    () => applyFlexibleLock({ auth: { id: "x", tenantId: scheme.tenantId, type: "TENANT_USER" }, scope: { tenantId: scheme.tenantId, branchId: scheme.branchId }, params: { schemeId: scheme._id }, headers: {}, ip: "127.0.0.1" }),
    (error) => error.code === "LOCK_ALREADY_APPLIED",
  );
  assert.equal(
    await AuditEvent.countDocuments({
      tenantId: scheme.tenantId,
      entityId: scheme._id,
      action: "FLEXIBLE_LOCK_APPLIED",
    }),
    1,
  );
});

test("concurrent lock produces one flex lock audit", async () => {
  const { scheme, lockReq } = await seedLockScheme({ startDate: "2020-01-01", durationMonths: 4 });
  setCalendarDateOverrideForTests("2025-01-01");
  const req = lockReq();
  const results = await Promise.allSettled([
    applyFlexibleLock(req),
    applyFlexibleLock(req),
  ]);
  assert.equal(results.filter((row) => row.status === "fulfilled").length, 1);
  assert.equal(
    await AuditEvent.countDocuments({
      tenantId: scheme.tenantId,
      entityId: scheme._id,
      action: "FLEXIBLE_LOCK_APPLIED",
    }),
    1,
  );
});

test("terminal closed scheme cannot lock", async () => {
  const { scheme, lockReq } = await seedLockScheme({ startDate: "2020-01-01", durationMonths: 4 });
  await Scheme.updateOne({ _id: scheme._id }, { $set: { status: SchemeStatus.CLOSED_PREMATURE } });
  setCalendarDateOverrideForTests("2025-01-01");
  await assert.rejects(
    () => applyFlexibleLock(lockReq()),
    (error) => error.code === "FLEXIBLE_LOCK_NOT_APPLICABLE",
  );
});
