import test from "node:test";
import assert from "node:assert/strict";
import {
  resetCalendarDateOverrideForTests,
  setCalendarDateOverrideForTests,
  today,
} from "../src/lib/date.js";
import { applyFlexibleLock } from "../src/services/scheme.service.js";
import { buildFlexibleSchemeCycleRows, isFlexibleLockDueAfterFreePhase } from "../src/lib/calendar-cycle.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { LedgerEntry, Scheme, SchemePlan } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { TenantRole } from "../src/constants/enums.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  resetCalendarDateOverrideForTests();
});
test.afterEach(() => { resetCalendarDateOverrideForTests(); });

test("calendar override throws outside NODE_ENV=test", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(
      () => setCalendarDateOverrideForTests("2020-01-01"),
      /only available in test/,
    );
  } finally {
    process.env.NODE_ENV = previous;
    resetCalendarDateOverrideForTests();
  }
});

test("reset restores real-date behaviour", () => {
  const realToday = today();
  setCalendarDateOverrideForTests("2019-06-15");
  assert.equal(today(), "2019-06-15");
  resetCalendarDateOverrideForTests();
  assert.equal(today(), realToday);
});

test("lock ignores body and query lockReferenceDate when calendar override unset", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const planId = createId("schemePlan");
  const flexRules = {
    flexiblePhaseCycles: 2,
    cappedPhaseCycles: 2,
    averagingDivisor: 2,
    flexiblePhase: { minTotalPaise: 0 },
    capComputation: {
      formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
      roundingMode: "ROUND_UP",
      roundToNearestPaise: 1000,
      minCycleCapPaise: 20_000,
      maxCycleCapPaise: 500_000,
      onZeroFlexiblePhaseTotal: "USE_MINIMUM",
      onBelowMinimumTotal: "USE_MINIMUM",
    },
  };
  await SchemePlan.create({
    _id: planId,
    tenantId: tenant._id,
    code: "DTLK",
    name: "Date lock",
    status: "ACTIVE",
    paymentPattern: "FLEXIBLE",
    valueBasis: "CASH",
    durationMonths: 4,
    installmentCount: 4,
    flexibleRules: flexRules,
  });
  const cycles = buildFlexibleSchemeCycleRows({
    startDate: "2026-01-10",
    durationMonths: 4,
    firstInstallmentMode: "COLLECT_NOW",
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    planId,
    enrollmentNumber: `ENR-DT-${Date.now()}`,
    planSnapshot: { paymentPattern: "FLEXIBLE", flexibleRules: flexRules },
    valueBasis: "CASH",
    paymentPattern: "FLEXIBLE",
    flexiblePhase: "FLEXIBLE",
    status: "ACTIVE",
    startDate: "2026-01-10",
    maturityDate: cycles.at(-1).expiresAt,
    cycles,
    version: 1,
    createdBy: user._id,
  });
  await LedgerEntry.create({
    _id: createId("ledger"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    sequence: 1,
    type: "FREE_WINDOW_PAYMENT",
    paymentId: "pay_1",
    amountPaise: 200_000,
    actorType: "USER",
    actorId: user._id,
  });
  const lockReq = {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { schemeId: scheme._id },
    headers: {},
    ip: "127.0.0.1",
    body: { lockReferenceDate: "2030-01-01" },
    query: { lockReferenceDate: "2030-01-01" },
  };
  const realToday = today();
  const dueReal = isFlexibleLockDueAfterFreePhase(realToday, cycles, 2);
  if (!dueReal) {
    await assert.rejects(
      () => applyFlexibleLock(lockReq),
      (error) => error.code === "FLEXIBLE_LOCK_NOT_DUE",
    );
  } else {
    const locked = await applyFlexibleLock(lockReq);
    assert.ok(locked.lockedAveragePaise > 0);
  }
});
