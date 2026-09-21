import test from "node:test";
import assert from "node:assert/strict";
import { buildFlexibleSchemeCycleRows } from "../src/lib/calendar-cycle.js";
import { resetCalendarDateOverrideForTests, setCalendarDateOverrideForTests, today } from "../src/lib/date.js";
import { applyFlexibleLock } from "../src/services/scheme.service.js";
import {
  initiateRedemption,
  settlementPreview,
  transitionRedemption,
} from "../src/services/redemption.service.js";
import { setGoldRate } from "../src/services/tenant.service.js";
import {
  LedgerEntry,
  Payment,
  Redemption,
  Scheme,
} from "../src/models/index.js";
import {
  ClosureType,
  LedgerEntryType,
  PaymentStatus,
  RedemptionMode,
  RedemptionStatus,
  SchemeStatus,
  TenantRole,
  ValueBasis,
} from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

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

const richRedemptionRules = {
  prematureClosureAllowed: true,
  lockInMonths: 0,
  allowedModes: [RedemptionMode.CASH, RedemptionMode.GOLD_HANDOVER, RedemptionMode.PURCHASE_ADJUSTMENT],
  prematurePenalty: { mode: "FLAT", flatPaise: 25_000, benefitTreatment: "FULL" },
};

const richBenefit = {
  type: "FIXED_BONUS_AMOUNT",
  bonusBasis: "FLAT",
  bonusValue: 40_000,
  eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
};

async function seedFlexBelowMinimumClosed({
  paidPaise = 60_000,
  redemptionRules = richRedemptionRules,
  benefit = richBenefit,
  valueBasis = ValueBasis.CASH,
} = {}) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const planId = createId("schemePlan");
  const cycles = buildFlexibleSchemeCycleRows({
    startDate: "2020-01-01",
    durationMonths: 4,
    firstInstallmentMode: "COLLECT_NOW",
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId,
    enrollmentNumber: `ENR-SPC-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FLEXIBLE",
      flexibleRules: closeRules,
      valueBasis,
      redemptionRules,
      benefit,
      ...(valueBasis === ValueBasis.GOLD_WEIGHT
        ? { goldRules: { weightRoundingMode: "HALF_UP", weightPrecisionMg: 1 } }
        : {}),
    },
    valueBasis,
    paymentPattern: "FLEXIBLE",
    flexiblePhase: "FLEXIBLE",
    status: SchemeStatus.ACTIVE,
    startDate: "2020-01-01",
    maturityDate: cycles[cycles.length - 1].expiresAt,
    cycles,
    version: 1,
    createdBy: user._id,
  });
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    receiptNumber: `R-${Date.now()}`,
    amountPaise: paidPaise,
    allocatedAmountPaise: paidPaise,
    mode: "CASH",
    source: "STAFF_APP",
    status: PaymentStatus.SUCCESS,
    paidAt: new Date(),
  });
  await LedgerEntry.create({
    _id: createId("ledger"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    type: valueBasis === ValueBasis.GOLD_WEIGHT ? LedgerEntryType.INSTALLMENT_PAYMENT : "FREE_WINDOW_PAYMENT",
    sequence: 1,
    paymentId,
    amountPaise: paidPaise,
    weightMg: valueBasis === ValueBasis.GOLD_WEIGHT ? 500 : undefined,
    actorType: "USER",
    actorId: user._id,
    description: "Paid",
  });
  await Scheme.updateOne({ _id: scheme._id }, { $set: { ledgerNextSequence: 1 } });
  setCalendarDateOverrideForTests("2025-06-01");
  const lockReq = {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { schemeId: scheme._id },
    headers: {},
    ip: "127.0.0.1",
  };
  await applyFlexibleLock(lockReq);
  const closed = await Scheme.findById(scheme._id).lean();
  return { tenant, branch, user, customer, scheme: closed, paidPaise, lockReq };
}

function staffReq({ user, tenant, branch, schemeId, body = {} }) {
  return {
    params: { schemeId },
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    body,
    query: {},
    headers: { "user-agent": "test" },
    ip: "127.0.0.1",
    tenant: { subscription: { tier: "GROWTH" } },
  };
}

async function setTodayRate({ user, tenant, branch, ratePerGramPaise }) {
  const day = today();
  setCalendarDateOverrideForTests(day);
  await setGoldRate({
    auth: { id: user._id, tenantId: tenant._id },
    headers: { "user-agent": "test" },
    body: { effectiveDate: day, ratePerGramPaise, branchId: branch._id },
  });
}

async function approveAndComplete(staff, redemptionId) {
  const row = await Redemption.findById(redemptionId).lean();
  if (row.status !== RedemptionStatus.APPROVED) {
    await transitionRedemption(
      { ...staff, params: { redemptionId } },
      "approve",
    );
  }
  await transitionRedemption(
    { ...staff, params: { redemptionId } },
    "complete",
  );
}

test("cash system closure: principal only despite FULL benefit and flat penalty on plan", async () => {
  const { tenant, branch, user, scheme, paidPaise } = await seedFlexBelowMinimumClosed();
  const preview = await settlementPreview(
    staffReq({ user, tenant, branch, schemeId: scheme._id, body: { mode: RedemptionMode.CASH } }),
    ClosureType.PREMATURE_CLOSURE,
  );
  assert.equal(preview.systemPolicyClosure, true);
  assert.equal(preview.closureReason, "BELOW_MINIMUM_FLEXIBLE_PHASE_TOTAL");
  assert.equal(preview.benefitPaise, 0);
  assert.equal(preview.penaltyPaise, 0);
  assert.equal(preview.settlementPaise, paidPaise);
  const initiated = await initiateRedemption(
    staffReq({
      user,
      tenant,
      branch,
      schemeId: scheme._id,
      body: { mode: RedemptionMode.CASH, expectedVersion: scheme.version },
    }),
    ClosureType.PREMATURE_CLOSURE,
  );
  const snap = initiated.modeDetails.settlementSnapshot;
  assert.equal(snap.systemPolicyClosure, true);
  assert.equal(snap.closureReason, "BELOW_MINIMUM_FLEXIBLE_PHASE_TOTAL");
  assert.equal(snap.benefitPaise, 0);
  assert.equal(snap.penaltyPaise, 0);
  await approveAndComplete(
    staffReq({ user, tenant, branch, schemeId: scheme._id }),
    initiated._id,
  );
  const ledgers = await LedgerEntry.find({ schemeId: scheme._id }).lean();
  assert.equal(ledgers.filter((r) => r.type === LedgerEntryType.REDEMPTION_DEBIT).length, 1);
  assert.equal(ledgers.filter((r) => r.type === LedgerEntryType.BENEFIT_CREDIT).length, 0);
  assert.equal(ledgers.filter((r) => r.type === LedgerEntryType.CLOSURE_PENALTY).length, 0);
  const after = await Scheme.findById(scheme._id).lean();
  assert.equal(after.settlementRequired, false);
  assert.ok(after.settlementCompletedAt);
  const ledgerCount = ledgers.length;
  await assert.rejects(
    () => transitionRedemption(
      { ...staffReq({ user, tenant, branch, schemeId: scheme._id }), params: { redemptionId: initiated._id } },
      "complete",
    ),
    (error) => error.code === "REDEMPTION_STATUS_INVALID",
  );
  assert.equal(await LedgerEntry.countDocuments({ schemeId: scheme._id }), ledgerCount);
});

test("spoofing: body systemPolicyClosure cannot zero penalty on ordinary premature closure", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const paid = 300_000;
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("plan"),
    enrollmentNumber: `ENR-NORM-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      valueBasis: ValueBasis.CASH,
      redemptionRules: {
        allowedModes: [RedemptionMode.CASH],
        prematureClosureAllowed: true,
        lockInMonths: 0,
        prematurePenalty: { mode: "FLAT", flatPaise: 20_000, benefitTreatment: "FORFEIT" },
      },
    },
    valueBasis: ValueBasis.CASH,
    paymentPattern: "FIXED",
    status: SchemeStatus.ACTIVE,
    startDate: "2020-01-01",
    maturityDate: "2025-01-01",
    installmentAmountPaise: paid,
    installments: [],
    version: 1,
    createdBy: user._id,
  });
  await LedgerEntry.create({
    _id: createId("ledger"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    type: LedgerEntryType.INSTALLMENT_PAYMENT,
    sequence: 1,
    amountPaise: paid,
    actorType: "USER",
    actorId: user._id,
    description: "Paid",
  });
  const preview = await settlementPreview(
    staffReq({
      user,
      tenant,
      branch,
      schemeId: scheme._id,
      body: {
        mode: RedemptionMode.CASH,
        systemPolicyClosure: true,
        modeDetails: { systemPolicyClosure: true, closureReason: "BELOW_MINIMUM_FLEXIBLE_PHASE_TOTAL" },
      },
    }),
    ClosureType.PREMATURE_CLOSURE,
  );
  assert.equal(preview.systemPolicyClosure, false);
  assert.equal(preview.penaltyPaise, 20_000);
  const initiated = await initiateRedemption(
    staffReq({
      user,
      tenant,
      branch,
      schemeId: scheme._id,
      body: {
        mode: RedemptionMode.CASH,
        expectedVersion: scheme.version,
        systemPolicyClosure: true,
        modeDetails: {
          acknowledgePenalty: true,
          acknowledgeBenefitForfeit: true,
          systemPolicyClosure: true,
          closureReason: "BELOW_MINIMUM_FLEXIBLE_PHASE_TOTAL",
        },
      },
    }),
    ClosureType.PREMATURE_CLOSURE,
  );
  assert.equal(initiated.penaltyPaise, 20_000);
  assert.equal(initiated.modeDetails.settlementSnapshot.systemPolicyClosure, false);
});

test("reversals reduce system-closure principal; unallocated payment excluded", async () => {
  const { tenant, branch, user, scheme } = await seedFlexBelowMinimumClosed({ paidPaise: 80_000 });
  await LedgerEntry.create({
    _id: createId("ledger"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    type: LedgerEntryType.REVERSAL,
    sequence: 2,
    amountPaise: 30_000,
    actorType: "USER",
    actorId: user._id,
    description: "Partial reversal",
  });
  const badPay = createId("payment");
  await Payment.create({
    _id: badPay,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    receiptNumber: "R-bad",
    amountPaise: 99_000,
    allocatedAmountPaise: 99_000,
    mode: "CASH",
    source: "STAFF_APP",
    status: PaymentStatus.UNALLOCATED_PENDING_REVIEW,
    paidAt: new Date(),
  });
  await LedgerEntry.create({
    _id: createId("ledger"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    type: "FREE_WINDOW_PAYMENT",
    sequence: 3,
    paymentId: badPay,
    amountPaise: 99_000,
    actorType: "USER",
    actorId: user._id,
    description: "Unallocated",
  });
  const preview = await settlementPreview(
    staffReq({ user, tenant, branch, schemeId: scheme._id, body: { mode: RedemptionMode.CASH } }),
    ClosureType.PREMATURE_CLOSURE,
  );
  assert.equal(preview.settlementPaise, 50_000);
});

test("customer self-settlement rejected for system-policy closure", async () => {
  const { tenant, customer, scheme } = await seedFlexBelowMinimumClosed();
  const refreshed = await Scheme.findById(scheme._id).lean();
  await assert.rejects(
    () => initiateRedemption(
      {
        params: { schemeId: scheme._id },
        auth: { id: customer._id, tenantId: tenant._id, type: "CUSTOMER" },
        scope: { tenantId: tenant._id },
        body: { mode: RedemptionMode.CASH, expectedVersion: refreshed.version },
        tenant: { subscription: { tier: "GROWTH" } },
      },
      ClosureType.PREMATURE_CLOSURE,
      true,
    ),
    (error) => error.code === "SETTLEMENT_STAFF_REQUIRED",
  );
});

test("gold-weight system closure GOLD_HANDOVER: principal weight only", async () => {
  const { tenant, branch, user, scheme } = await seedFlexBelowMinimumClosed({
    valueBasis: ValueBasis.GOLD_WEIGHT,
    paidPaise: 250_000,
  });
  await setTodayRate({ user, tenant, branch, ratePerGramPaise: 500_000 });
  const preview = await settlementPreview(
    staffReq({
      user,
      tenant,
      branch,
      schemeId: scheme._id,
      body: { mode: RedemptionMode.GOLD_HANDOVER },
    }),
    ClosureType.PREMATURE_CLOSURE,
  );
  assert.equal(preview.systemPolicyClosure, true);
  assert.equal(preview.benefitWeightMg, 0);
  assert.equal(preview.penaltyWeightMg, 0);
  assert.equal(preview.weightMg, 500);
  const initiated = await initiateRedemption(
    staffReq({
      user,
      tenant,
      branch,
      schemeId: scheme._id,
      body: { mode: RedemptionMode.GOLD_HANDOVER, expectedVersion: scheme.version },
    }),
    ClosureType.PREMATURE_CLOSURE,
  );
  await approveAndComplete(
    staffReq({ user, tenant, branch, schemeId: scheme._id }),
    initiated._id,
  );
  const completed = await Redemption.findById(initiated._id).lean();
  assert.equal(completed.weightMg, 500);
  assert.equal(completed.benefitWeightMg, 0);
  assert.equal(completed.penaltyWeightMg, 0);
});

test("gold-weight system closure CASH: valued at completion-day 22K; missing rate blocks complete", async () => {
  const { tenant, branch, user, scheme } = await seedFlexBelowMinimumClosed({
    valueBasis: ValueBasis.GOLD_WEIGHT,
    paidPaise: 250_000,
  });
  const settlementDay = "2025-08-15";
  setCalendarDateOverrideForTests(settlementDay);
  await setGoldRate({
    auth: { id: user._id, tenantId: tenant._id },
    headers: { "user-agent": "test" },
    body: { effectiveDate: settlementDay, ratePerGramPaise: 400_000, branchId: branch._id },
  });
  const initiated = await initiateRedemption(
    staffReq({
      user,
      tenant,
      branch,
      schemeId: scheme._id,
      body: { mode: RedemptionMode.CASH, expectedVersion: scheme.version },
    }),
    ClosureType.PREMATURE_CLOSURE,
  );
  const redemptionId = initiated._id;
  await transitionRedemption(
    { ...staffReq({ user, tenant, branch, schemeId: scheme._id }), params: { redemptionId } },
    "approve",
  );
  const schemeBefore = await Scheme.findById(scheme._id).lean();
  const redemptionBefore = await Redemption.findById(redemptionId).lean();
  setCalendarDateOverrideForTests("2099-01-01");
  await assert.rejects(
    () => transitionRedemption(
      { ...staffReq({ user, tenant, branch, schemeId: scheme._id }), params: { redemptionId } },
      "complete",
    ),
    (error) => error.code === "GOLD_RATE_NOT_SET",
  );
  assert.equal((await Scheme.findById(scheme._id).lean()).settlementRequired, schemeBefore.settlementRequired);
  assert.equal((await Redemption.findById(redemptionId).lean()).status, redemptionBefore.status);
  assert.equal(
    await LedgerEntry.countDocuments({
      schemeId: scheme._id,
      redemptionId,
      type: { $in: [LedgerEntryType.REDEMPTION_DEBIT, LedgerEntryType.BENEFIT_CREDIT, LedgerEntryType.CLOSURE_PENALTY] },
    }),
    0,
  );
  setCalendarDateOverrideForTests(settlementDay);
  await setGoldRate({
    auth: { id: user._id, tenantId: tenant._id },
    headers: { "user-agent": "test" },
    body: { effectiveDate: settlementDay, ratePerGramPaise: 400_000, branchId: branch._id },
  });
  await transitionRedemption(
    { ...staffReq({ user, tenant, branch, schemeId: scheme._id }), params: { redemptionId } },
    "complete",
  );
  const completed = await Redemption.findById(redemptionId).lean();
  assert.equal(completed.cashOutPaise, 200_000);
  assert.equal(completed.benefitPaise, 0);
  assert.equal(completed.penaltyPaise, 0);
});

test("fully reversed principal blocks system settlement", async () => {
  const { tenant, branch, user, scheme, paidPaise } = await seedFlexBelowMinimumClosed();
  await LedgerEntry.create({
    _id: createId("ledger"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    type: LedgerEntryType.REVERSAL,
    sequence: 2,
    amountPaise: paidPaise,
    actorType: "USER",
    actorId: user._id,
    description: "Full reversal",
  });
  const preview = await settlementPreview(
    staffReq({ user, tenant, branch, schemeId: scheme._id, body: { mode: RedemptionMode.CASH } }),
    ClosureType.PREMATURE_CLOSURE,
  );
  assert.equal(preview.eligible, false);
  assert.ok(
    preview.blockers.some((b) =>
      ["SETTLEMENT_PRINCIPAL_ZERO", "SETTLEMENT_NON_POSITIVE"].includes(b.code),
    ),
  );
});
