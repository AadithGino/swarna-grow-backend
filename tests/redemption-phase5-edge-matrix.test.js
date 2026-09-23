import test from "node:test";
import assert from "node:assert/strict";
import {
  GoldRate,
  LedgerEntry,
  Redemption,
  Scheme,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import {
  ClosureType,
  LedgerEntryType,
  RedemptionMode,
  RedemptionStatus,
  SchemeStatus,
  TenantRole,
  ValueBasis,
} from "../src/constants/enums.js";
import {
  SETTLEMENT_SNAPSHOT_FIELD_KEYS,
  buildSettlementSnapshotFromPreview,
  computeGoldWeightModeSettlement,
  convertBenefitPaiseToWeightMg,
  convertMoneyToPlanWeightMg,
} from "../src/lib/scheme-closure-settlement.js";
import {
  decimalRoundingMode,
  moneyPaiseFromWeightMg,
  moneyToWeightMg,
  weightMgToMoneyPaise,
  MONEY_PAISE_ROUNDING,
} from "../src/lib/money.js";
import Decimal from "decimal.js";
import {
  resetCalendarDateOverrideForTests,
  setCalendarDateOverrideForTests,
  today,
} from "../src/lib/date.js";
import { setGoldRate } from "../src/services/tenant.service.js";
import {
  initiateRedemption,
  requestCustomerRedemption,
  settlementPreview,
  transitionRedemption,
} from "../src/services/redemption.service.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { buildEligibleMaturedFixedSchemeFields } from "./helpers/maturity-fixtures.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  resetCalendarDateOverrideForTests();
});
test.afterEach(() => {
  if (process.env.NODE_ENV === "test") resetCalendarDateOverrideForTests();
});

function adminReq({ user, scheme, redemptionId, body = {} }) {
  return {
    auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
    scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
    params: { redemptionId, id: redemptionId },
    body,
    query: {},
    headers: {},
    ip: "127.0.0.1",
  };
}

async function seedCashMatured({ paid = 300_000, allowedModes = [RedemptionMode.CASH, RedemptionMode.GOLD_HANDOVER] } = {}) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-EM-C-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      valueBasis: ValueBasis.CASH,
      redemptionRules: { allowedModes, prematureClosureAllowed: false },
      benefit: { type: "TEXT_ONLY", displayLabel: "Gift" },
    },
    valueBasis: ValueBasis.CASH,
    paymentPattern: "FIXED",
    status: SchemeStatus.MATURED,
    ...buildEligibleMaturedFixedSchemeFields({
      totalPaidPaise: paid,
      startDate: "2020-01-01",
      maturityDate: "2025-01-01",
    }),
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
  await Scheme.updateOne({ _id: scheme._id }, { $set: { ledgerNextSequence: 1 } });
  return { tenant, branch, user, customer, scheme, paid };
}

async function seedGoldWeightMatured({
  weightMg = 500,
  amountPaise = 250_000,
  goldRules = { weightRoundingMode: "HALF_UP", weightPrecisionMg: 1 },
  allowedModes = [RedemptionMode.CASH, RedemptionMode.GOLD_HANDOVER, RedemptionMode.PURCHASE_ADJUSTMENT],
  benefitDef,
  redemptionRules,
}) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-EM-GW-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      valueBasis: ValueBasis.GOLD_WEIGHT,
      goldRules,
      redemptionRules: redemptionRules ?? {
        allowedModes,
        prematureClosureAllowed: true,
        lockInMonths: 0,
        prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
      },
      benefit: benefitDef ?? { type: "TEXT_ONLY", displayLabel: "Gift" },
    },
    valueBasis: ValueBasis.GOLD_WEIGHT,
    paymentPattern: "FIXED",
    status: SchemeStatus.MATURED,
    ...buildEligibleMaturedFixedSchemeFields({
      totalPaidPaise: amountPaise,
      startDate: "2020-01-01",
      maturityDate: "2025-01-01",
    }),
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
    amountPaise,
    weightMg,
    actorType: "USER",
    actorId: user._id,
    description: "Gold",
  });
  await Scheme.updateOne({ _id: scheme._id }, { $set: { ledgerNextSequence: 1 } });
  return { tenant, branch, user, customer, scheme, weightMg, amountPaise };
}

async function seedCashScheme({ paid, status, redemptionRules, allowedModes, benefitDef }) {
  const ctx = await seedCashMatured({
    paid,
    allowedModes: allowedModes ?? [RedemptionMode.CASH],
  });
  await Scheme.updateOne(
    { _id: ctx.scheme._id },
    {
      $set: {
        status,
        "planSnapshot.redemptionRules": redemptionRules,
        ...(benefitDef ? { "planSnapshot.benefit": benefitDef } : {}),
      },
    },
  );
  return { ...ctx, scheme: await Scheme.findById(ctx.scheme._id).lean() };
}

async function setRateOnDay({ user, tenant, branch, day, ratePerGramPaise }) {
  await setGoldRate({
    auth: { id: user._id, tenantId: tenant._id },
    headers: { "user-agent": "test" },
    body: { effectiveDate: day, ratePerGramPaise, branchId: branch._id },
  });
}

async function assertBlockedCompleteNoWrites({ schemeId, redemptionId, user, scheme, errorCode }) {
  const schemeBefore = await Scheme.findById(schemeId).lean();
  const redemptionBefore = await Redemption.findById(redemptionId).lean();
  await assert.rejects(
    () => transitionRedemption(adminReq({ user, scheme, redemptionId }), "complete"),
    (error) => error.code === errorCode,
  );
  const schemeAfter = await Scheme.findById(schemeId).lean();
  const redemptionAfter = await Redemption.findById(redemptionId).lean();
  assert.equal(schemeAfter.status, schemeBefore.status);
  assert.equal(redemptionAfter.status, redemptionBefore.status);
  assert.equal(
    await LedgerEntry.countDocuments({
      schemeId,
      redemptionId,
      type: { $in: [LedgerEntryType.BENEFIT_CREDIT, LedgerEntryType.CLOSURE_PENALTY, LedgerEntryType.REDEMPTION_DEBIT] },
    }),
    0,
  );
}

async function initiateApproved({ user, scheme, mode, closureType = ClosureType.MATURITY_REDEMPTION, modeDetails = {} }) {
  const row = await initiateRedemption(
    {
      auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
      scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
      params: { schemeId: scheme._id },
      body: { mode, expectedVersion: scheme.version, modeDetails },
      query: {},
      headers: {},
      ip: "127.0.0.1",
    },
    closureType,
  );
  if (row.status !== RedemptionStatus.APPROVED) {
    await transitionRedemption(adminReq({ user, scheme, redemptionId: row._id }), "approve");
  }
  return row._id ?? row.id;
}

const rateMatrixCases = [
  {
    label: "CASH plan → GOLD_HANDOVER",
    seed: () => seedCashMatured({ allowedModes: [RedemptionMode.CASH, RedemptionMode.GOLD_HANDOVER] }),
    mode: RedemptionMode.GOLD_HANDOVER,
    needsModeOnPreview: false,
  },
  {
    label: "GOLD_WEIGHT → CASH",
    seed: () => seedGoldWeightMatured({ allowedModes: [RedemptionMode.CASH] }),
    mode: RedemptionMode.CASH,
    needsModeOnPreview: true,
  },
  {
    label: "GOLD_WEIGHT → GOLD_HANDOVER",
    seed: () => seedGoldWeightMatured({ allowedModes: [RedemptionMode.GOLD_HANDOVER] }),
    mode: RedemptionMode.GOLD_HANDOVER,
    needsModeOnPreview: true,
  },
  {
    label: "GOLD_WEIGHT → PURCHASE_ADJUSTMENT",
    seed: () => seedGoldWeightMatured({
      allowedModes: [RedemptionMode.PURCHASE_ADJUSTMENT, RedemptionMode.CASH],
    }),
    mode: RedemptionMode.PURCHASE_ADJUSTMENT,
    needsModeOnPreview: true,
    billNumber: "BILL-RATE-1",
  },
];

for (const row of rateMatrixCases) {
  test(`exact-date rate: only previous-day 22K blocks ${row.label}`, async () => {
    const ctx = await row.seed();
    const { tenant, branch, user, scheme } = ctx;
    const day = "2026-03-10";
    setCalendarDateOverrideForTests(day);
    await GoldRate.create({
      _id: createId("grt"),
      tenantId: tenant._id,
      branchId: branch._id,
      effectiveDate: "2026-03-09",
      ratePerGramPaise: 400_000,
      purity: "22K",
      enteredBy: user._id,
    });
    if (row.needsModeOnPreview || ctx.weightMg || row.mode === RedemptionMode.GOLD_HANDOVER) {
      await setRateOnDay({ user, tenant, branch, day, ratePerGramPaise: 500_000 });
    }
    const modeDetails = row.billNumber ? { billNumber: row.billNumber } : {};
    const redemptionId = await initiateApproved({
      user,
      scheme,
      mode: row.mode,
      modeDetails,
    });
    await GoldRate.deleteMany({ tenantId: tenant._id, branchId: branch._id, effectiveDate: day });
    await assertBlockedCompleteNoWrites({
      schemeId: scheme._id,
      redemptionId,
      user,
      scheme,
      errorCode: "GOLD_RATE_NOT_SET",
    });
  });

  test(`exact-date rate: only future-day 22K blocks ${row.label}`, async () => {
    const ctx = await row.seed();
    const { tenant, branch, user, scheme } = ctx;
    const day = "2026-04-01";
    setCalendarDateOverrideForTests(day);
    await setRateOnDay({ user, tenant, branch, day: "2026-04-02", ratePerGramPaise: 500_000 });
    if (row.needsModeOnPreview || ctx.weightMg || row.mode === RedemptionMode.GOLD_HANDOVER) {
      await setRateOnDay({ user, tenant, branch, day, ratePerGramPaise: 500_000 });
    }
    const modeDetails = row.billNumber ? { billNumber: row.billNumber } : {};
    const redemptionId = await initiateApproved({ user, scheme, mode: row.mode, modeDetails });
    await GoldRate.deleteMany({ tenantId: tenant._id, branchId: branch._id, effectiveDate: day });
    await assertBlockedCompleteNoWrites({
      schemeId: scheme._id,
      redemptionId,
      user,
      scheme,
      errorCode: "GOLD_RATE_NOT_SET",
    });
  });

  test(`exact-date rate: raw 24K without 22K blocks ${row.label}`, async () => {
    const ctx = await row.seed();
    const { tenant, branch, user, scheme } = ctx;
    const day = "2026-05-01";
    setCalendarDateOverrideForTests(day);
    await GoldRate.collection.insertOne({
      _id: createId("grt"),
      tenantId: tenant._id,
      branchId: branch._id,
      effectiveDate: day,
      ratePerGramPaise: 999_999,
      purity: "24K",
      enteredBy: user._id,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const needsRateForInit =
      row.needsModeOnPreview || ctx.weightMg || row.mode === RedemptionMode.GOLD_HANDOVER;
    if (needsRateForInit) {
      await assert.rejects(
        () => initiateApproved({
          user,
          scheme,
          mode: row.mode,
          modeDetails: row.billNumber ? { billNumber: row.billNumber } : {},
        }),
        (error) => error.code === "GOLD_RATE_NOT_SET",
      );
      return;
    }
    const redemptionId = await initiateApproved({
      user,
      scheme,
      mode: row.mode,
      modeDetails: row.billNumber ? { billNumber: row.billNumber } : {},
    });
    await assertBlockedCompleteNoWrites({
      schemeId: scheme._id,
      redemptionId,
      user,
      scheme,
      errorCode: "GOLD_RATE_NOT_SET",
    });
  });
}

test("exact-date 24K and 22K on same day selects 22K for GOLD_WEIGHT CASH completion", async () => {
  const { tenant, branch, user, scheme } = await seedGoldWeightMatured({
    weightMg: 400,
    allowedModes: [RedemptionMode.CASH],
  });
  const day = "2026-06-01";
  setCalendarDateOverrideForTests(day);
  await GoldRate.collection.insertOne({
    _id: createId("grt24"),
    tenantId: tenant._id,
    branchId: branch._id,
    effectiveDate: day,
    ratePerGramPaise: 999_999,
    purity: "24K",
    enteredBy: user._id,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await setRateOnDay({ user, tenant, branch, day, ratePerGramPaise: 500_000 });
  const redemptionId = await initiateApproved({ user, scheme, mode: RedemptionMode.CASH });
  await transitionRedemption(adminReq({ user, scheme, redemptionId }), "complete");
  const completed = await Redemption.findById(redemptionId).lean();
  assert.equal(completed.cashOutPaise, 200_000);
  assert.notEqual(completed.cashOutPaise, 399_999);
});

test("penalty one paise below settlement completes with positive cashOut", async () => {
  const paid = 10_000;
  const { user, scheme } = await seedCashScheme({
    paid,
    status: SchemeStatus.ACTIVE,
    redemptionRules: {
      allowedModes: [RedemptionMode.CASH],
      prematureClosureAllowed: true,
      lockInMonths: 0,
      prematurePenalty: { mode: "FLAT", flatPaise: paid - 1, benefitTreatment: "FORFEIT" },
    },
  });
  const redemptionId = await initiateApproved({
    user,
    scheme,
    mode: RedemptionMode.CASH,
    closureType: ClosureType.PREMATURE_CLOSURE,
    modeDetails: { acknowledgeBenefitForfeit: true, acknowledgePenalty: true },
  });
  await transitionRedemption(adminReq({ user, scheme, redemptionId }), "complete");
  const completed = await Redemption.findById(redemptionId).lean();
  assert.equal(completed.cashOutPaise, 1);
});

test("penalty equals settlement blocked at initiate with SETTLEMENT_NON_POSITIVE", async () => {
  const paid = 10_000;
  const { user, scheme } = await seedCashScheme({
    paid,
    status: SchemeStatus.ACTIVE,
    redemptionRules: {
      allowedModes: [RedemptionMode.CASH],
      prematureClosureAllowed: true,
      lockInMonths: 0,
      prematurePenalty: { mode: "FLAT", flatPaise: paid, benefitTreatment: "FORFEIT" },
    },
  });
  await assert.rejects(
    () => initiateRedemption(
      {
        auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
        scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
        params: { schemeId: scheme._id },
        body: {
          mode: RedemptionMode.CASH,
          expectedVersion: scheme.version,
          modeDetails: { acknowledgeBenefitForfeit: true, acknowledgePenalty: true },
        },
        query: {},
        headers: {},
        ip: "127.0.0.1",
      },
      ClosureType.PREMATURE_CLOSURE,
    ),
    (error) => error.code === "SETTLEMENT_NON_POSITIVE",
  );
});

test("percentage penalty exceeding settlement blocked at preview", async () => {
  const paid = 50_000;
  const { user, scheme } = await seedCashScheme({
    paid,
    status: SchemeStatus.ACTIVE,
    redemptionRules: {
      allowedModes: [RedemptionMode.CASH],
      prematureClosureAllowed: true,
      lockInMonths: 0,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 100, benefitTreatment: "FORFEIT" },
    },
  });
  const preview = await settlementPreview(
    {
      auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
      scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
      params: { schemeId: scheme._id },
      body: { mode: RedemptionMode.CASH },
      query: {},
      headers: {},
      ip: "127.0.0.1",
    },
    ClosureType.PREMATURE_CLOSURE,
  );
  assert.equal(preview.eligible, false);
  assert.equal(preview.blockers.some((b) => b.code === "SETTLEMENT_NON_POSITIVE"), true);
});

test("gold handover penalty weight equals eligible weight blocked at preview", async () => {
  const { tenant, branch, user, scheme, weightMg } = await seedGoldWeightMatured({
    weightMg: 1000,
    amountPaise: 500_000,
    redemptionRules: {
      allowedModes: [RedemptionMode.GOLD_HANDOVER],
      prematureClosureAllowed: true,
      lockInMonths: 0,
      prematurePenalty: { mode: "FLAT", flatPaise: 1, benefitTreatment: "FORFEIT" },
    },
    goldRules: { weightRoundingMode: "HALF_UP", weightPrecisionMg: 1 },
  });
  const day = "2026-07-01";
  setCalendarDateOverrideForTests(day);
  await setRateOnDay({ user, tenant, branch, day, ratePerGramPaise: 520_000 });
  const eligibleValue = moneyPaiseFromWeightMg(weightMg, 520_000);
  await Scheme.updateOne(
    { _id: scheme._id },
    { $set: { "planSnapshot.redemptionRules.prematurePenalty.flatPaise": eligibleValue } },
  );
  const refreshed = await Scheme.findById(scheme._id).lean();
  const preview = await settlementPreview(
    {
      auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
      scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
      params: { schemeId: refreshed._id },
      body: { mode: RedemptionMode.GOLD_HANDOVER },
      query: {},
      headers: {},
      ip: "127.0.0.1",
    },
    ClosureType.PREMATURE_CLOSURE,
  );
  assert.equal(preview.eligible, false);
  assert.ok(
    preview.blockers.some((b) =>
      ["GOLD_WEIGHT_ROUNDS_TO_ZERO", "SETTLEMENT_NON_POSITIVE"].includes(b.code),
    ),
  );
});

test("gold handover penalty weight exceeds eligible weight blocked at preview", async () => {
  const { tenant, branch, user, scheme, weightMg } = await seedGoldWeightMatured({
    weightMg: 500,
    amountPaise: 250_000,
    redemptionRules: {
      allowedModes: [RedemptionMode.GOLD_HANDOVER],
      prematureClosureAllowed: true,
      lockInMonths: 0,
      prematurePenalty: { mode: "FLAT", flatPaise: 999_999_999, benefitTreatment: "FORFEIT" },
    },
  });
  const day = "2026-07-02";
  setCalendarDateOverrideForTests(day);
  await setRateOnDay({ user, tenant, branch, day, ratePerGramPaise: 500_000 });
  const preview = await settlementPreview(
    {
      auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
      scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
      params: { schemeId: scheme._id },
      body: { mode: RedemptionMode.GOLD_HANDOVER },
      query: {},
      headers: {},
      ip: "127.0.0.1",
    },
    ClosureType.PREMATURE_CLOSURE,
  );
  assert.equal(preview.eligible, false);
  assert.ok(preview.penaltyWeightMg > weightMg || preview.blockers.length > 0);
});

const roundingCases = [
  { mode: "ROUND_DOWN", precision: 1, benefitPaise: 125_000, rate: 500_000, expectedBenefitMg: 250 },
  { mode: "ROUND_UP", precision: 1, benefitPaise: 125_000, rate: 500_000, expectedBenefitMg: 250 },
  { mode: "HALF_UP", precision: 1, benefitPaise: 125_000, rate: 500_000, expectedBenefitMg: 250 },
  { mode: "ROUND_DOWN", precision: 10, benefitPaise: 123_456, rate: 500_000, expectedBenefitMg: 240 },
  { mode: "ROUND_UP", precision: 10, benefitPaise: 123_456, rate: 500_000, expectedBenefitMg: 250 },
  { mode: "HALF_UP", precision: 10, benefitPaise: 123_456, rate: 500_000, expectedBenefitMg: 250 },
];

for (const row of roundingCases) {
  test(`weight rounding ${row.mode} precision ${row.precision} benefit mg = ${row.expectedBenefitMg}`, async () => {
    const rounding = decimalRoundingMode(row.mode);
    const computed = convertBenefitPaiseToWeightMg(
      row.benefitPaise,
      row.rate,
      rounding,
      row.precision,
    );
    assert.equal(computed, row.expectedBenefitMg);
    const { tenant, branch, user, scheme } = await seedGoldWeightMatured({
      weightMg: 500,
      amountPaise: 300_000,
      goldRules: { weightRoundingMode: row.mode, weightPrecisionMg: row.precision },
      benefitDef: {
        type: "FIXED_BONUS_AMOUNT",
        bonusBasis: "FLAT",
        bonusValue: row.benefitPaise,
        eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
      },
      redemptionRules: {
        allowedModes: [RedemptionMode.GOLD_HANDOVER],
        prematureClosureAllowed: false,
      },
    });
    const day = "2026-08-01";
    setCalendarDateOverrideForTests(day);
    await setRateOnDay({ user, tenant, branch, day, ratePerGramPaise: row.rate });
    const settlement = computeGoldWeightModeSettlement({
      mode: RedemptionMode.GOLD_HANDOVER,
      principalWeightMg: 500,
      benefitWeightMg: row.expectedBenefitMg,
      penaltyPaise: 0,
      ratePerGramPaise: row.rate,
      rounding,
      precisionMg: row.precision,
    });
    assert.ok(settlement.finalHandoverWeightMg > 0);
    const redemptionId = await initiateApproved({
      user,
      scheme,
      mode: RedemptionMode.GOLD_HANDOVER,
    });
    await transitionRedemption(adminReq({ user, scheme, redemptionId }), "complete");
    const completed = await Redemption.findById(redemptionId).lean();
    assert.equal(completed.benefitWeightMg, row.expectedBenefitMg);
    assert.equal(completed.weightMg, settlement.finalHandoverWeightMg);
  });
}

test("penalty paise to weight uses plan rounding (flat and percent)", async () => {
  const rounding = decimalRoundingMode("ROUND_DOWN");
  const rate = 520_000;
  const flatMg = convertMoneyToPlanWeightMg(52_000, rate, rounding, 10);
  assert.equal(flatMg, 100);
  const { user, scheme } = await seedCashScheme({
    paid: 200_000,
    status: SchemeStatus.ACTIVE,
    redemptionRules: {
      allowedModes: [RedemptionMode.CASH],
      prematureClosureAllowed: true,
      lockInMonths: 0,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 10, benefitTreatment: "FORFEIT" },
    },
  });
  const preview = await settlementPreview(
    {
      auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
      scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
      params: { schemeId: scheme._id },
      body: { mode: RedemptionMode.CASH },
      query: {},
      headers: {},
      ip: "127.0.0.1",
    },
    ClosureType.PREMATURE_CLOSURE,
  );
  assert.equal(preview.penaltyPaise, 20_000);
});

test("mg to paise uses HALF_UP and ignores plan weight rounding for cash valuation", () => {
  const weightMg = 333;
  const rate = 555_555;
  const moneyVal = moneyPaiseFromWeightMg(weightMg, rate);
  const downVal = weightMgToMoneyPaise(weightMg, rate, Decimal.ROUND_DOWN);
  const upVal = weightMgToMoneyPaise(weightMg, rate, Decimal.ROUND_UP);
  const expectedHalfUp = new Decimal(weightMg)
    .mul(rate)
    .div(1000)
    .toDecimalPlaces(0, MONEY_PAISE_ROUNDING)
    .toNumber();
  assert.equal(moneyVal, expectedHalfUp);
  assert.equal(moneyVal, 185_000);
  assert.equal(downVal, 184_999);
  assert.equal(upVal, 185_000);
  assert.notEqual(downVal, moneyVal);
  assert.equal(moneyVal, moneyPaiseFromWeightMg(weightMg, rate));
});

test("two-day drift GOLD_WEIGHT CASH: stale snapshot then day-two completion", async () => {
  const { tenant, branch, user, customer, scheme } = await seedGoldWeightMatured({
    weightMg: 500,
    allowedModes: [RedemptionMode.CASH],
  });
  setCalendarDateOverrideForTests("2026-09-01");
  await setRateOnDay({ user, tenant, branch, day: "2026-09-01", ratePerGramPaise: 400_000 });
  const requested = await requestCustomerRedemption({
    auth: { id: customer._id, tenantId: tenant._id, type: "CUSTOMER" },
    scope: { tenantId: tenant._id },
    params: { schemeId: scheme._id },
    body: { preferredMode: RedemptionMode.CASH, expectedVersion: scheme.version },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  });
  const day1Settlement = (await Redemption.findById(requested.id).lean()).settlementPaise;
  assert.equal(day1Settlement, 200_000);
  await transitionRedemption(adminReq({ user, scheme, redemptionId: requested.id }), "approve");
  setCalendarDateOverrideForTests("2026-09-02");
  await setRateOnDay({ user, tenant, branch, day: "2026-09-02", ratePerGramPaise: 600_000 });
  await assert.rejects(
    () => transitionRedemption(adminReq({ user, scheme, redemptionId: requested.id }), "complete"),
    (error) => error.code === "SETTLEMENT_VALUE_CHANGED",
  );
  await Redemption.deleteOne({ _id: requested.id });
  const requested2 = await requestCustomerRedemption({
    auth: { id: customer._id, tenantId: tenant._id, type: "CUSTOMER" },
    scope: { tenantId: tenant._id },
    params: { schemeId: scheme._id },
    body: { preferredMode: RedemptionMode.CASH, expectedVersion: scheme.version },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  });
  await transitionRedemption(adminReq({ user, scheme, redemptionId: requested2.id }), "approve");
  await transitionRedemption(adminReq({ user, scheme, redemptionId: requested2.id }), "complete");
  const completed = await Redemption.findById(requested2.id).lean();
  assert.equal(completed.cashOutPaise, 300_000);
  assert.notEqual(completed.cashOutPaise, day1Settlement);
  assert.equal(completed.modeDetails.settlementSnapshot.valuationRateEffectiveDate, "2026-09-02");
});

test("two-day drift GOLD_WEIGHT GOLD_HANDOVER: stale snapshot then day-two completion", async () => {
  const benefitPaise = 125_000;
  const { tenant, branch, user, customer, scheme } = await seedGoldWeightMatured({
    weightMg: 600,
    allowedModes: [RedemptionMode.GOLD_HANDOVER],
    benefitDef: {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "FLAT",
      bonusValue: benefitPaise,
      eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
    },
  });
  setCalendarDateOverrideForTests("2026-09-10");
  await setRateOnDay({ user, tenant, branch, day: "2026-09-10", ratePerGramPaise: 500_000 });
  const requested = await requestCustomerRedemption({
    auth: { id: customer._id, tenantId: tenant._id, type: "CUSTOMER" },
    scope: { tenantId: tenant._id },
    params: { schemeId: scheme._id },
    body: { preferredMode: RedemptionMode.GOLD_HANDOVER, expectedVersion: scheme.version },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  });
  const day1Row = await Redemption.findById(requested.id).lean();
  const day1Weight = day1Row.weightMg;
  assert.equal(day1Row.benefitWeightMg, 250);
  await transitionRedemption(adminReq({ user, scheme, redemptionId: requested.id }), "approve");
  setCalendarDateOverrideForTests("2026-09-11");
  await setRateOnDay({ user, tenant, branch, day: "2026-09-11", ratePerGramPaise: 400_000 });
  await assert.rejects(
    () => transitionRedemption(adminReq({ user, scheme, redemptionId: requested.id }), "complete"),
    (error) => error.code === "SETTLEMENT_VALUE_CHANGED",
  );
  assert.equal((await Redemption.findById(requested.id).lean()).status, RedemptionStatus.APPROVED);
  await Redemption.deleteOne({ _id: requested.id });
  const requested2 = await requestCustomerRedemption({
    auth: { id: customer._id, tenantId: tenant._id, type: "CUSTOMER" },
    scope: { tenantId: tenant._id },
    params: { schemeId: scheme._id },
    body: { preferredMode: RedemptionMode.GOLD_HANDOVER, expectedVersion: scheme.version },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  });
  await transitionRedemption(adminReq({ user, scheme, redemptionId: requested2.id }), "approve");
  await transitionRedemption(adminReq({ user, scheme, redemptionId: requested2.id }), "complete");
  const completed = await Redemption.findById(requested2.id).lean();
  assert.equal(completed.handoverRateEffectiveDate, "2026-09-11");
  assert.equal(completed.handoverRatePerGramPaise, 400_000);
  assert.equal(completed.benefitWeightMg, 313);
  assert.equal(completed.weightMg, 913);
  assert.notEqual(completed.weightMg, day1Weight);
});

test("two-day drift CASH plan GOLD_HANDOVER uses day-two rate on recreate", async () => {
  const { tenant, branch, user, scheme } = await seedCashMatured({
    paid: 300_000,
    allowedModes: [RedemptionMode.GOLD_HANDOVER],
  });
  setCalendarDateOverrideForTests("2026-10-01");
  await setRateOnDay({ user, tenant, branch, day: "2026-10-01", ratePerGramPaise: 500_000 });
  const id1 = await initiateApproved({ user, scheme, mode: RedemptionMode.GOLD_HANDOVER });
  setCalendarDateOverrideForTests("2026-10-02");
  await setRateOnDay({ user, tenant, branch, day: "2026-10-02", ratePerGramPaise: 600_000 });
  await assert.rejects(
    () => transitionRedemption(adminReq({ user, scheme, redemptionId: id1 }), "complete"),
    (error) => error.code === "SETTLEMENT_VALUE_CHANGED",
  );
  await Redemption.deleteOne({ _id: id1 });
  await setRateOnDay({ user, tenant, branch, day: "2026-10-02", ratePerGramPaise: 600_000 });
  const id2 = await initiateApproved({ user, scheme, mode: RedemptionMode.GOLD_HANDOVER });
  await transitionRedemption(adminReq({ user, scheme, redemptionId: id2 }), "complete");
  const completed = await Redemption.findById(id2).lean();
  assert.equal(completed.handoverRateEffectiveDate, "2026-10-02");
  assert.equal(completed.handoverRatePerGramPaise, 600_000);
  assert.notEqual(
    completed.weightMg,
    moneyToWeightMg(300_000, 500_000, decimalRoundingMode("HALF_UP")),
  );
});

test("benefit persisted: mature fixed on CASH plan single BENEFIT_CREDIT", async () => {
  const bonus = 25_000;
  const paid = 300_000;
  const { user, scheme } = await seedCashMatured({ paid });
  await Scheme.updateOne(
    { _id: scheme._id },
    {
      $set: {
        "planSnapshot.benefit": {
          type: "FIXED_BONUS_AMOUNT",
          bonusBasis: "FLAT",
          bonusValue: bonus,
          eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
        },
      },
    },
  );
  const refreshed = await Scheme.findById(scheme._id).lean();
  const redemptionId = await initiateApproved({ user, scheme: refreshed, mode: RedemptionMode.CASH });
  await transitionRedemption(adminReq({ user, scheme: refreshed, redemptionId }), "complete");
  const completed = await Redemption.findById(redemptionId).lean();
  assert.equal(completed.benefitPaise, bonus);
  assert.equal(completed.settlementPaise, paid + bonus);
  assert.equal(
    await LedgerEntry.countDocuments({ schemeId: scheme._id, type: LedgerEntryType.BENEFIT_CREDIT }),
    1,
  );
});

test("benefit persisted: premature FORFEIT zero benefit and no BENEFIT_CREDIT on GOLD_WEIGHT", async () => {
  const { tenant, branch, user, scheme } = await seedGoldWeightMatured({
    weightMg: 500,
    status: SchemeStatus.ACTIVE,
    benefitDef: {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "FLAT",
      bonusValue: 40_000,
    },
    redemptionRules: {
      allowedModes: [RedemptionMode.CASH],
      prematureClosureAllowed: true,
      lockInMonths: 0,
      prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
    },
  });
  await Scheme.updateOne({ _id: scheme._id }, { $set: { status: SchemeStatus.ACTIVE } });
  const day = today();
  setCalendarDateOverrideForTests(day);
  await setRateOnDay({ user, tenant, branch, day, ratePerGramPaise: 500_000 });
  const redemptionId = await initiateApproved({
    user,
    scheme,
    mode: RedemptionMode.CASH,
    closureType: ClosureType.PREMATURE_CLOSURE,
    modeDetails: { acknowledgeBenefitForfeit: true },
  });
  await transitionRedemption(adminReq({ user, scheme, redemptionId }), "complete");
  const completed = await Redemption.findById(redemptionId).lean();
  assert.equal(completed.benefitPaise, 0);
  assert.equal(
    await LedgerEntry.countDocuments({ schemeId: scheme._id, type: LedgerEntryType.BENEFIT_CREDIT }),
    0,
  );
});

test("snapshot tamper: removing settlementPaise fails completion", async () => {
  const { user, scheme } = await seedCashMatured({ paid: 200_000 });
  const preview = await settlementPreview(
    {
      auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
      scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
      params: { schemeId: scheme._id },
      body: { mode: RedemptionMode.CASH },
      query: {},
      headers: {},
      ip: "127.0.0.1",
    },
    ClosureType.MATURITY_REDEMPTION,
  );
  const snapshot = buildSettlementSnapshotFromPreview(preview, scheme.version, RedemptionMode.CASH);
  delete snapshot.settlementPaise;
  const row = await Redemption.create({
    _id: createId("red"),
    tenantId: scheme.tenantId,
    branchId: scheme.branchId,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    closureType: ClosureType.MATURITY_REDEMPTION,
    mode: RedemptionMode.CASH,
    status: RedemptionStatus.APPROVED,
    settlementPaise: preview.settlementPaise,
    principalPaise: preview.principalPaise,
    version: 1,
    modeDetails: { settlementSnapshot: snapshot },
  });
  await assert.rejects(
    () => transitionRedemption(adminReq({ user, scheme, redemptionId: row._id }), "complete"),
    (error) => error.code === "SETTLEMENT_SNAPSHOT_REQUIRED",
  );
});

test("snapshot tamper: changing weightMg fails SETTLEMENT_VALUE_CHANGED", async () => {
  const { tenant, branch, user, scheme } = await seedGoldWeightMatured({
    weightMg: 500,
    allowedModes: [RedemptionMode.CASH],
  });
  const day = today();
  setCalendarDateOverrideForTests(day);
  await setRateOnDay({ user, tenant, branch, day, ratePerGramPaise: 500_000 });
  const preview = await settlementPreview(
    {
      auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
      scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
      params: { schemeId: scheme._id },
      body: { mode: RedemptionMode.CASH },
      query: {},
      headers: {},
      ip: "127.0.0.1",
    },
    ClosureType.MATURITY_REDEMPTION,
  );
  const snapshot = buildSettlementSnapshotFromPreview(preview, scheme.version, RedemptionMode.CASH);
  snapshot.weightMg = snapshot.weightMg + 10;
  const row = await Redemption.create({
    _id: createId("red"),
    tenantId: scheme.tenantId,
    branchId: scheme.branchId,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    closureType: ClosureType.MATURITY_REDEMPTION,
    mode: RedemptionMode.CASH,
    status: RedemptionStatus.APPROVED,
    settlementPaise: preview.settlementPaise,
    principalPaise: preview.principalPaise,
    version: 1,
    modeDetails: { settlementSnapshot: snapshot },
  });
  await assert.rejects(
    () => transitionRedemption(adminReq({ user, scheme, redemptionId: row._id }), "complete"),
    (error) => error.code === "SETTLEMENT_VALUE_CHANGED",
  );
});

for (const key of SETTLEMENT_SNAPSHOT_FIELD_KEYS) {
  test(`new request snapshot includes ${key}`, async () => {
    const { tenant, branch, user, customer, scheme } = await seedGoldWeightMatured({
      weightMg: 400,
      allowedModes: [RedemptionMode.CASH],
    });
    await setRateOnDay({ user, tenant, branch, day: today(), ratePerGramPaise: 500_000 });
    const result = await requestCustomerRedemption({
      auth: { id: customer._id, tenantId: tenant._id, type: "CUSTOMER" },
      scope: { tenantId: tenant._id },
      params: { schemeId: scheme._id },
      body: { preferredMode: RedemptionMode.CASH, expectedVersion: scheme.version },
      query: {},
      headers: {},
      ip: "127.0.0.1",
    });
    const row = await Redemption.findById(result.id).lean();
    assert.ok(Object.prototype.hasOwnProperty.call(row.modeDetails.settlementSnapshot, key));
  });
}
