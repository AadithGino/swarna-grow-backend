import test from "node:test";
import assert from "node:assert/strict";
import { buildFlexibleSchemeCycleRows } from "../src/lib/calendar-cycle.js";
import { resetCalendarDateOverrideForTests, setCalendarDateOverrideForTests } from "../src/lib/date.js";
import { applyFlexibleLock } from "../src/services/scheme.service.js";
import { settlementPreview, initiateRedemption, transitionRedemption } from "../src/services/redemption.service.js";
import { assertOneActiveSchemePolicy } from "../src/lib/enrolment-in-transaction-validation.js";
import { ENROLMENT_CAPACITY_STATUSES } from "../src/lib/scheme-enrollment-status.js";
import {
  Alert,
  AuditEvent,
  LedgerEntry,
  Message,
  OutboxEvent,
  Payment,
  Scheme,
  SchemePlan,
} from "../src/models/index.js";
import { ClosureType, PaymentStatus, RedemptionMode, SchemeStatus, TenantRole } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { processOutbox } from "../src/workers/processors.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import mongoose from "mongoose";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  resetCalendarDateOverrideForTests();
});
test.afterEach(() => { resetCalendarDateOverrideForTests(); });

const closeRules = {
  flexiblePhaseCycles: 2,
  cappedPhaseCycles: 2,
  averagingDivisor: 2,
  flexiblePhase: { minTotalPaise: 100_000 },
  capComputation: {
    formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
    roundToNearestPaise: 1000,
    minCycleCapPaise: 20_000,
    maxCycleCapPaise: 500_000,
    onZeroFlexiblePhaseTotal: "CLOSE_SCHEME",
    onBelowMinimumTotal: "CLOSE_SCHEME",
  },
};

async function seedFlexLockClose({
  rules = closeRules,
  ledgerEntries = [],
  startDate = "2020-01-01",
} = {}) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const planId = createId("schemePlan");
  await SchemePlan.create({
    _id: planId,
    tenantId: tenant._id,
    code: "FLXS",
    name: "Flex settlement",
    status: "ACTIVE",
    paymentPattern: "FLEXIBLE",
    valueBasis: "CASH",
    durationMonths: 4,
    installmentCount: 4,
    flexibleRules: rules,
    redemptionRules: {
      prematureClosureAllowed: false,
      lockInMonths: 12,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 10, benefitTreatment: "FORFEIT" },
      allowedModes: ["CASH"],
    },
  });
  const cycles = buildFlexibleSchemeCycleRows({
    startDate,
    durationMonths: 4,
    firstInstallmentMode: "COLLECT_NOW",
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId,
    enrollmentNumber: `ENR-SET-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FLEXIBLE",
      flexibleRules: rules,
      redemptionRules: {
        prematureClosureAllowed: false,
        lockInMonths: 12,
        prematurePenalty: { mode: "PERCENT_OF_PAID", value: 10, benefitTreatment: "FORFEIT" },
        allowedModes: ["CASH"],
      },
    },
    valueBasis: "CASH",
    paymentPattern: "FLEXIBLE",
    flexiblePhase: "FLEXIBLE",
    status: SchemeStatus.ACTIVE,
    startDate,
    maturityDate: cycles[cycles.length - 1].expiresAt,
    cycles,
    version: 1,
    createdBy: user._id,
  });
  if (ledgerEntries.length) {
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
  }
  const lockReq = {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { schemeId: scheme._id },
    headers: {},
    ip: "127.0.0.1",
  };
  setCalendarDateOverrideForTests("2025-06-01");
  return { tenant, branch, user, customer, scheme, lockReq, planId };
}

test("zero net total closes with settlementRequired false", async () => {
  const { scheme, lockReq } = await seedFlexLockClose({
    ledgerEntries: [
      { type: "FREE_WINDOW_PAYMENT", paymentId: "pay_1", amountPaise: 50_000 },
      { type: "REVERSAL", reversalOf: "pay_1", amountPaise: 50_000 },
    ],
  });
  const result = await applyFlexibleLock(lockReq);
  const refreshed = await Scheme.findById(scheme._id).lean();
  assert.equal(result.closureReason ?? result.closeReason, "ZERO_FLEXIBLE_PHASE_TOTAL");
  assert.equal(refreshed.status, SchemeStatus.CLOSED_PREMATURE);
  assert.equal(refreshed.settlementRequired, false);
  assert.equal(refreshed.settlementPrincipalPaise, 0);
  assert.ok(refreshed.closedAt);
});

test("below minimum with paid principal closes with settlement required", async () => {
  const { scheme, lockReq, user } = await seedFlexLockClose({
    ledgerEntries: [
      { type: "FREE_WINDOW_PAYMENT", paymentId: "pay_ok", amountPaise: 60_000 },
    ],
  });
  await Payment.create({
    _id: "pay_ok",
    tenantId: scheme.tenantId,
    branchId: scheme.branchId,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    receiptNumber: "R-1",
    amountPaise: 60_000,
    allocatedAmountPaise: 60_000,
    mode: "CASH",
    source: "STAFF_APP",
    status: PaymentStatus.SUCCESS,
    paidAt: new Date(),
  });
  await applyFlexibleLock(lockReq);
  const refreshed = await Scheme.findById(scheme._id).lean();
  assert.equal(refreshed.closureReason, "BELOW_MINIMUM_FLEXIBLE_PHASE_TOTAL");
  assert.equal(refreshed.settlementRequired, true);
  assert.equal(refreshed.settlementPrincipalPaise, 60_000);
  assert.equal(
    await Alert.countDocuments({ tenantId: scheme.tenantId, entityId: scheme._id, type: "FLEX_SETTLEMENT_REQUIRED", status: "OPEN" }),
    1,
  );
  const preview = await settlementPreview(
    { params: { schemeId: scheme._id }, auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" }, scope: { tenantId: scheme.tenantId, branchId: scheme.branchId } },
    ClosureType.PREMATURE_CLOSURE,
  );
  assert.equal(preview.eligible, true);
  assert.equal(preview.penaltyPaise, 0);
  assert.equal(preview.benefitPaise, 0);
  assert.equal(preview.settlementPaise, 60_000);
});

test("exactly minimum net total locks instead of closing", async () => {
  const rules = { ...closeRules, flexiblePhase: { minTotalPaise: 100_000 } };
  const { scheme, lockReq } = await seedFlexLockClose({
    rules,
    ledgerEntries: [{ type: "FREE_WINDOW_PAYMENT", paymentId: "pay_1", amountPaise: 100_000 }],
  });
  const locked = await applyFlexibleLock(lockReq);
  assert.equal(locked.status, SchemeStatus.LOCKED);
  assert.equal((await Scheme.findById(scheme._id).lean()).settlementRequired, false);
});

test("USE_MINIMUM locks instead of closing below minimum", async () => {
  const rules = {
    ...closeRules,
    flexiblePhase: { minTotalPaise: 200_000 },
    capComputation: {
      ...closeRules.capComputation,
      onBelowMinimumTotal: "USE_MINIMUM",
      onZeroFlexiblePhaseTotal: "USE_MINIMUM",
      minCycleCapPaise: 55_000,
    },
  };
  const { lockReq } = await seedFlexLockClose({
    rules,
    ledgerEntries: [{ type: "FREE_WINDOW_PAYMENT", paymentId: "pay_1", amountPaise: 80_000 }],
  });
  const locked = await applyFlexibleLock(lockReq);
  assert.equal(locked.status, SchemeStatus.LOCKED);
  assert.equal(locked.lockedAveragePaise, 55_000);
});

test("repeat lock closure does not duplicate audit outbox or alert", async () => {
  const { scheme, lockReq } = await seedFlexLockClose({
    ledgerEntries: [{ type: "FREE_WINDOW_PAYMENT", paymentId: "pay_1", amountPaise: 50_000 }],
  });
  await applyFlexibleLock(lockReq);
  await applyFlexibleLock(lockReq).catch(() => {});
  assert.equal(await AuditEvent.countDocuments({ tenantId: scheme.tenantId, entityId: scheme._id, action: "SCHEME_CLOSED_PREMATURE" }), 1);
  assert.equal(await OutboxEvent.countDocuments({ tenantId: scheme.tenantId, topic: "scheme.flex_policy.closed", key: `${scheme._id}:BELOW_MINIMUM_FLEXIBLE_PHASE_TOTAL` }), 1);
  assert.equal(await Alert.countDocuments({ tenantId: scheme.tenantId, entityId: scheme._id, type: "FLEX_SETTLEMENT_REQUIRED" }), 1);
});

test("outbox processor queues SCHEME_CLOSED notification once", async () => {
  const { scheme, lockReq, tenant } = await seedFlexLockClose({
    ledgerEntries: [{ type: "FREE_WINDOW_PAYMENT", paymentId: "pay_1", amountPaise: 50_000 }],
  });
  await applyFlexibleLock(lockReq);
  const outbox = await OutboxEvent.findOne({ tenantId: tenant._id, topic: "scheme.flex_policy.closed" }).lean();
  await processOutbox({ data: { outboxEventId: String(outbox._id) }, attemptsMade: 0 });
  const afterFirst = await Message.countDocuments({ tenantId: tenant._id, schemeId: scheme._id, type: "SCHEME_CLOSED" });
  assert.ok(afterFirst >= 1);
  await processOutbox({ data: { outboxEventId: String(outbox._id) }, attemptsMade: 1 });
  assert.equal(
    await Message.countDocuments({ tenantId: tenant._id, schemeId: scheme._id, type: "SCHEME_CLOSED" }),
    afterFirst,
  );
});

test("customer cannot initiate flex-policy settlement", async () => {
  const { scheme, lockReq, customer } = await seedFlexLockClose({
    ledgerEntries: [{ type: "FREE_WINDOW_PAYMENT", paymentId: "pay_1", amountPaise: 50_000 }],
  });
  await applyFlexibleLock(lockReq);
  await assert.rejects(
    () => initiateRedemption(
      {
        params: { schemeId: scheme._id },
        auth: { id: customer._id, tenantId: scheme.tenantId, type: "CUSTOMER" },
        scope: { tenantId: scheme.tenantId },
        body: { mode: RedemptionMode.CASH, expectedVersion: 2 },
        tenant: { subscription: { tier: "GROWTH" } },
      },
      ClosureType.PREMATURE_CLOSURE,
      true,
    ),
    (error) => error.code === "SETTLEMENT_STAFF_REQUIRED",
  );
});

test("staff redemption completion clears settlementRequired", async () => {
  const { scheme, lockReq, user, tenant, branch } = await seedFlexLockClose({
    ledgerEntries: [{ type: "FREE_WINDOW_PAYMENT", paymentId: "pay_1", amountPaise: 50_000 }],
  });
  await Payment.create({
    _id: "pay_1",
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    receiptNumber: "R-2",
    amountPaise: 50_000,
    allocatedAmountPaise: 50_000,
    mode: "CASH",
    source: "STAFF_APP",
    status: PaymentStatus.SUCCESS,
    paidAt: new Date(),
  });
  await applyFlexibleLock(lockReq);
  const refreshed = await Scheme.findById(scheme._id).lean();
  const staffReq = {
    params: { schemeId: scheme._id },
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    body: { mode: RedemptionMode.CASH, expectedVersion: refreshed.version },
    headers: { "user-agent": "test" },
    ip: "127.0.0.1",
    baseUrl: "/api/v1/admin",
    tenant: { subscription: { tier: "GROWTH" } },
  };
  const row = await initiateRedemption(
    staffReq,
    ClosureType.PREMATURE_CLOSURE,
    false,
  );
  const redemptionId = row._id ?? row.id;
  if (row.status === "PENDING_APPROVAL" || row.status === "REQUESTED") {
    await transitionRedemption(
      { ...staffReq, params: { redemptionId }, body: {} },
      "approve",
    );
  }
  await transitionRedemption(
    {
      ...staffReq,
      params: { redemptionId },
      body: {},
    },
    "complete",
  );
  const after = await Scheme.findById(scheme._id).lean();
  assert.equal(after.settlementRequired, false);
  assert.ok(after.settlementCompletedAt);
});

test("closed flex-policy scheme does not block one-active policy", async () => {
  const { lockReq, tenant, customer } = await seedFlexLockClose({
    ledgerEntries: [{ type: "FREE_WINDOW_PAYMENT", paymentId: "pay_1", amountPaise: 50_000 }],
  });
  await applyFlexibleLock(lockReq);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await assertOneActiveSchemePolicy(session, tenant._id, customer._id);
    });
  } finally {
    await session.endSession();
  }
});

test("closed flex-policy scheme does not consume plan capacity", async () => {
  const { lockReq, planId, tenant } = await seedFlexLockClose({
    ledgerEntries: [{ type: "FREE_WINDOW_PAYMENT", paymentId: "pay_1", amountPaise: 50_000 }],
  });
  await applyFlexibleLock(lockReq);
  const count = await Scheme.countDocuments({
    tenantId: tenant._id,
    planId,
    status: { $in: ENROLMENT_CAPACITY_STATUSES },
  });
  assert.equal(count, 0);
});
