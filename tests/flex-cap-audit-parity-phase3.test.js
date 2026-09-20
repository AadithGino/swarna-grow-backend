import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFreeWindowLedgerForCap } from "../src/lib/flexible-free-window-net.js";
import {
  buildIllustrativeFreeWindowNetSummary,
  computeFlexibleLockCapDetails,
} from "../src/lib/flexible-cap.js";
import { buildFlexibleEnrolPreview } from "../src/services/plan.service.js";
import { applyFlexibleLock } from "../src/services/scheme.service.js";
import { AuditEvent, LedgerEntry, Scheme, SchemePlan } from "../src/models/index.js";
import { buildFlexibleSchemeCycleRows } from "../src/lib/calendar-cycle.js";
import { resetCalendarDateOverrideForTests, setCalendarDateOverrideForTests } from "../src/lib/date.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { TenantRole } from "../src/constants/enums.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  resetCalendarDateOverrideForTests();
});

const flexRules = {
  flexiblePhaseCycles: 3,
  cappedPhaseCycles: 3,
  averagingDivisor: 4,
  flexiblePhase: { minTotalPaise: 0 },
  capComputation: {
    formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
    roundingMode: "ROUND_UP",
    roundToNearestPaise: 10_000,
    minCycleCapPaise: 50_000,
    maxCycleCapPaise: 200_000,
    onZeroFlexiblePhaseTotal: "USE_MINIMUM",
    onBelowMinimumTotal: "USE_MINIMUM",
  },
};

function assertFullCapAudit(audit) {
  for (const key of [
    "formula",
    "grossSuccessfulFreeWindowTotalPaise",
    "totalReversalAmountPaise",
    "netFreeTotalPaise",
    "originalPositivePaymentCount",
    "netPositivePaymentCount",
    "configuredAveragingDivisor",
    "actualDivisorUsed",
    "unroundedQuotient",
    "roundingMode",
    "roundToNearestPaise",
    "roundedBeforeClamp",
    "minimumFloor",
    "maximumCeiling",
    "finalCapPaise",
    "contributingPaymentIds",
    "contributingPaymentLedgerEntryIds",
    "reversalLedgerEntryIds",
  ]) {
    assert.ok(Object.hasOwn(audit, key), `missing audit.${key}`);
  }
}

test("preview and runtime lock share cap result for divisor formula", async () => {
  const netSummary = buildIllustrativeFreeWindowNetSummary({
    installmentAmountPaise: 50_000,
    flexiblePhaseCycles: 3,
  });
  const preview = computeFlexibleLockCapDetails({ netSummary, flexibleRules: flexRules });
  const plan = { paymentPattern: "FLEXIBLE", durationMonths: 6, flexibleRules: flexRules };
  const enrolPreview = buildFlexibleEnrolPreview(plan, 50_000, "2026-01-01", "COLLECT_NOW");
  assert.equal(enrolPreview.illustrativeCapPerCycle.amountPaise, preview.capPaise);
});

test("payment-count formula parity", async () => {
  const rules = {
    ...flexRules,
    capComputation: {
      ...flexRules.capComputation,
      formula: "FLEXIBLE_PHASE_TOTAL_DIV_PAYMENT_COUNT",
    },
  };
  const entries = [
    { _id: "led_a", type: "FREE_WINDOW_PAYMENT", paymentId: "pay_a", amountPaise: 40_000 },
    { _id: "led_b", type: "FREE_WINDOW_PAYMENT", paymentId: "pay_b", amountPaise: 60_000 },
  ];
  const netSummary = analyzeFreeWindowLedgerForCap(entries);
  const { capPaise } = computeFlexibleLockCapDetails({ netSummary, flexibleRules: rules });
  assert.equal(capPaise, 50_000);
});

test("lock audit includes every required field with ledger ids", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const planId = createId("schemePlan");
  await SchemePlan.create({
    _id: planId,
    tenantId: tenant._id,
    code: "AUD",
    name: "Audit",
    status: "ACTIVE",
    paymentPattern: "FLEXIBLE",
    valueBasis: "CASH",
    durationMonths: 4,
    installmentCount: 4,
    flexibleRules: flexRules,
  });
  const cycles = buildFlexibleSchemeCycleRows({
    startDate: "2020-01-01",
    durationMonths: 4,
    firstInstallmentMode: "COLLECT_NOW",
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    planId,
    enrollmentNumber: `ENR-AUD-${Date.now()}`,
    planSnapshot: { paymentPattern: "FLEXIBLE", flexibleRules: flexRules },
    valueBasis: "CASH",
    paymentPattern: "FLEXIBLE",
    flexiblePhase: "FLEXIBLE",
    status: "ACTIVE",
    startDate: "2020-01-01",
    maturityDate: cycles.at(-1).expiresAt,
    cycles,
    version: 1,
    createdBy: user._id,
  });
  const ledgerRows = [
    { _id: createId("ledger"), type: "FREE_WINDOW_PAYMENT", paymentId: "pay_1", amountPaise: 120_000 },
    { _id: createId("ledger"), type: "FREE_WINDOW_PAYMENT", paymentId: "pay_2", amountPaise: 80_000 },
    { _id: createId("ledger"), type: "REVERSAL", reversalOf: "pay_2", amountPaise: 30_000 },
  ];
  await LedgerEntry.insertMany(
    ledgerRows.map((row, index) => ({
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId: scheme.customerId,
      sequence: index + 1,
      actorType: "USER",
      actorId: user._id,
      amountPaise: row.amountPaise,
      ...row,
    })),
  );
  setCalendarDateOverrideForTests("2025-01-01");
  const locked = await applyFlexibleLock({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { schemeId: scheme._id },
    headers: {},
    ip: "127.0.0.1",
  });
  assertFullCapAudit(locked.flexibleLockComputation);
  assert.ok(locked.flexibleLockComputation.freePhaseBoundary);
  assert.ok(locked.flexibleLockComputation.lockedAt);
  const auditRow = await AuditEvent.findOne({
    tenantId: tenant._id,
    entityId: scheme._id,
    action: "FLEXIBLE_LOCK_APPLIED",
  }).lean();
  assert.ok(auditRow?.after?.flexibleLockComputation);
  assertFullCapAudit(auditRow.after.flexibleLockComputation);
});

test("ROUND_DOWN and HALF_UP rounding modes", async () => {
  const baseNet = {
    netFreeTotalPaise: 125_000,
    netPositivePaymentCount: 2,
    grossSuccessfulFreeWindowTotalPaise: 125_000,
    totalReversalAmountPaise: 0,
    originalPositivePaymentCount: 2,
  };
  const down = computeFlexibleLockCapDetails({
    netSummary: baseNet,
    flexibleRules: {
      ...flexRules,
      capComputation: { ...flexRules.capComputation, roundingMode: "ROUND_DOWN", minCycleCapPaise: 0, maxCycleCapPaise: 1_000_000 },
    },
  });
  const half = computeFlexibleLockCapDetails({
    netSummary: baseNet,
    flexibleRules: {
      ...flexRules,
      capComputation: { ...flexRules.capComputation, roundingMode: "HALF_UP", minCycleCapPaise: 0, maxCycleCapPaise: 1_000_000 },
    },
  });
  assert.equal(down.capPaise, 30_000);
  assert.equal(half.capPaise, 30_000);
});
