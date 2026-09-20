import test from "node:test";
import assert from "node:assert/strict";
import { computeFlexibleCycleCapPaise } from "../src/lib/flexible-cap.js";
import { summarizeFreeWindowLedgerNet } from "../src/lib/flexible-free-window-net.js";
import { applyFlexibleLock } from "../src/services/scheme.service.js";
import { buildFlexibleEnrolPreview } from "../src/services/plan.service.js";
import { LedgerEntry, Scheme, SchemePlan } from "../src/models/index.js";
import { FlexiblePhase, SchemeStatus, TenantRole } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

const flexRulesBase = {
  flexiblePhaseCycles: 2,
  cappedPhaseCycles: 3,
  averagingDivisor: 2,
  flexiblePhase: { minTotalPaise: 100000 },
  capComputation: {
    formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
    roundToNearestPaise: 1000,
    minCycleCapPaise: 20000,
    maxCycleCapPaise: 500000,
    onZeroFlexiblePhaseTotal: "CLOSE_SCHEME",
    onBelowMinimumTotal: "CLOSE_SCHEME",
  },
};

async function seedFlexibleSchemeForLock({ ledgerEntries, rules = flexRulesBase, overrides = {} } = {}) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const planId = createId("schemePlan");
  await SchemePlan.create({
    _id: planId,
    tenantId: tenant._id,
    code: "FLX3",
    name: "Flex lock",
    status: "ACTIVE",
    paymentPattern: "FLEXIBLE",
    valueBasis: "CASH",
    durationMonths: 5,
    installmentCount: 5,
    flexibleRules: rules,
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId,
    enrollmentNumber: `ENR-FL3-${Date.now()}`,
    planSnapshot: { paymentPattern: "FLEXIBLE", flexibleRules: rules },
    valueBasis: "CASH",
    paymentPattern: "FLEXIBLE",
    flexiblePhase: FlexiblePhase.FLEXIBLE,
    status: SchemeStatus.ACTIVE,
    startDate: "2026-01-01",
    maturityDate: "2026-06-01",
    cycles: [
      { cycle: "2026-01", capPaise: 0, paidPaise: 0, remainingPaise: 0, status: "UPCOMING" },
      { cycle: "2026-02", capPaise: 0, paidPaise: 0, remainingPaise: 0, status: "UPCOMING" },
    ],
    version: 1,
    createdBy: user._id,
    ...overrides,
  });
  if (ledgerEntries?.length) {
    await LedgerEntry.insertMany(
      ledgerEntries.map((row, index) => ({
        _id: createId("ledger"),
        tenantId: tenant._id,
        branchId: branch._id,
        schemeId: scheme._id,
        customerId: customer._id,
        sequence: index + 1,
        actorType: "USER",
        actorId: user._id,
        ...row,
      })),
    );
    await Scheme.updateOne({ _id: scheme._id }, { $set: { ledgerNextSequence: ledgerEntries.length } });
  }
  const lockReq = {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { schemeId: scheme._id },
    headers: {},
    ip: "127.0.0.1",
  };
  return { tenant, branch, user, scheme, lockReq, planId };
}

test("zero net total closes scheme when policy is CLOSE_SCHEME", async () => {
  const { scheme, lockReq } = await seedFlexibleSchemeForLock({
    ledgerEntries: [
      { type: "FREE_WINDOW_PAYMENT", paymentId: "pay_1", amountPaise: 50000 },
      { type: "REVERSAL", reversalOf: "pay_1", amountPaise: 50000 },
    ],
  });
  const locked = await applyFlexibleLock(lockReq);
  assert.equal(locked.status, SchemeStatus.CLOSED_PREMATURE);
  assert.equal(locked.closeReason, "ZERO_FLEXIBLE_PHASE_TOTAL");
  const refreshed = await Scheme.findById(scheme._id).lean();
  assert.equal(refreshed.flexiblePhase, FlexiblePhase.FLEXIBLE);
});

test("exactly minimum net total locks instead of closing", async () => {
  const minTotal = flexRulesBase.flexiblePhase.minTotalPaise;
  const { lockReq } = await seedFlexibleSchemeForLock({
    ledgerEntries: [{ type: "FREE_WINDOW_PAYMENT", paymentId: "pay_1", amountPaise: minTotal }],
  });
  const locked = await applyFlexibleLock(lockReq);
  assert.equal(locked.status, SchemeStatus.LOCKED);
  assert.ok(locked.lockedAveragePaise > 0);
});

test("below minimum net total closes scheme when policy is CLOSE_SCHEME", async () => {
  const { lockReq } = await seedFlexibleSchemeForLock({
    ledgerEntries: [{ type: "FREE_WINDOW_PAYMENT", paymentId: "pay_1", amountPaise: 50000 }],
  });
  const locked = await applyFlexibleLock(lockReq);
  assert.equal(locked.status, SchemeStatus.CLOSED_PREMATURE);
  assert.equal(locked.closeReason, "BELOW_MINIMUM_FLEXIBLE_PHASE_TOTAL");
});

test("lock preview matches runtime cap for same ledger net", async () => {
  const rules = {
    ...flexRulesBase,
    capComputation: {
      ...flexRulesBase.capComputation,
      onBelowMinimumTotal: "USE_MINIMUM",
      onZeroFlexiblePhaseTotal: "USE_MINIMUM",
    },
    flexiblePhase: { minTotalPaise: 0 },
  };
  const entries = [
    { type: "FREE_WINDOW_PAYMENT", paymentId: "pay_a", amountPaise: 80000 },
    { type: "FREE_WINDOW_PAYMENT", paymentId: "pay_b", amountPaise: 40000 },
  ];
  const net = summarizeFreeWindowLedgerNet(entries);
  const previewCap = computeFlexibleCycleCapPaise({
    totalPaise: net.netTotalPaise,
    freeWindowPaymentCount: net.netPositivePaymentCount,
    flexibleRules: rules,
  });
  const { lockReq } = await seedFlexibleSchemeForLock({ ledgerEntries: entries, rules });
  const locked = await applyFlexibleLock(lockReq);
  assert.equal(locked.lockedAveragePaise, previewCap);
  assert.equal(locked.flexibleLockComputation.netFreeTotalPaise, net.netTotalPaise);
});

test("enrol preview cap matches lock helper for illustrative totals", () => {
  const plan = {
    paymentPattern: "FLEXIBLE",
    durationMonths: 5,
    flexibleRules: flexRulesBase,
  };
  const preview = buildFlexibleEnrolPreview(plan, 50000, "2026-01-01", "COLLECT_NOW");
  const expected = computeFlexibleCycleCapPaise({
    totalPaise: 50000 * (flexRulesBase.flexiblePhaseCycles ?? 2),
    freeWindowPaymentCount: flexRulesBase.flexiblePhaseCycles ?? 2,
    flexibleRules: flexRulesBase,
  });
  assert.equal(preview.illustrativeCapPerCycle.amountPaise, expected);
});

test("zero net with USE_MINIMUM policy applies minimum cap instead of closing", async () => {
  const rules = {
    ...flexRulesBase,
    flexiblePhase: { minTotalPaise: 0 },
    capComputation: {
      ...flexRulesBase.capComputation,
      minCycleCapPaise: 45000,
      onZeroFlexiblePhaseTotal: "USE_MINIMUM",
      onBelowMinimumTotal: "USE_MINIMUM",
    },
  };
  const { lockReq } = await seedFlexibleSchemeForLock({
    rules,
    ledgerEntries: [
      { type: "FREE_WINDOW_PAYMENT", paymentId: "pay_1", amountPaise: 90000 },
      { type: "REVERSAL", reversalOf: "pay_1", amountPaise: 90000 },
    ],
  });
  const locked = await applyFlexibleLock(lockReq);
  assert.equal(locked.status, SchemeStatus.LOCKED);
  assert.equal(locked.lockedAveragePaise, 45000);
});

test("repeat lock after success is rejected without changing cap", async () => {
  const { scheme, lockReq } = await seedFlexibleSchemeForLock({
    ledgerEntries: [{ type: "FREE_WINDOW_PAYMENT", paymentId: "pay_1", amountPaise: 180000 }],
  });
  const locked = await applyFlexibleLock(lockReq);
  assert.equal(locked.status, SchemeStatus.LOCKED);
  await assert.rejects(
    () => applyFlexibleLock(lockReq),
    (error) => error.code === "LOCK_ALREADY_APPLIED",
  );
  const refreshed = await Scheme.findById(scheme._id).lean();
  assert.equal(refreshed.lockedAveragePaise, locked.lockedAveragePaise);
  assert.equal(refreshed.flexiblePhase, FlexiblePhase.CAPPED);
});

test("parallel lock attempts: one applies cap once", async () => {
  const { lockReq } = await seedFlexibleSchemeForLock({
    rules: {
      ...flexRulesBase,
      flexiblePhase: { minTotalPaise: 0 },
      capComputation: {
        ...flexRulesBase.capComputation,
        onBelowMinimumTotal: "USE_MINIMUM",
        onZeroFlexiblePhaseTotal: "USE_MINIMUM",
      },
    },
    ledgerEntries: [{ type: "FREE_WINDOW_PAYMENT", paymentId: "pay_1", amountPaise: 200000 }],
  });
  const results = await Promise.allSettled([
    applyFlexibleLock(lockReq),
    applyFlexibleLock(lockReq),
  ]);
  const fulfilled = results.filter((row) => row.status === "fulfilled");
  const rejected = results.filter((row) => row.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.code, "LOCK_ALREADY_APPLIED");
});
