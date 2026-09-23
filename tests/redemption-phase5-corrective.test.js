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
} from "../src/lib/scheme-closure-settlement.js";
import { setGoldRate } from "../src/services/tenant.service.js";
import {
  initiateRedemption,
  requestCustomerRedemption,
  settlementPreview,
  transitionRedemption,
} from "../src/services/redemption.service.js";
import { redemptionPeriodSummary } from "../src/services/redemption-period-summary.js";
import { today } from "../src/lib/date.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { buildEligibleMaturedFixedSchemeFields } from "./helpers/maturity-fixtures.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

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

function previewReq(scheme, user, { mode, closureType = ClosureType.MATURITY_REDEMPTION } = {}) {
  return {
    auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
    scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
    params: { schemeId: scheme._id },
    body: mode ? { mode } : {},
    query: mode ? { mode } : {},
    headers: {},
    ip: "127.0.0.1",
    closureType,
  };
}

async function seedCashScheme({
  paid,
  status = SchemeStatus.MATURED,
  benefitDef,
  redemptionRules,
  allowedModes = [RedemptionMode.CASH],
}) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-C5-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      valueBasis: ValueBasis.CASH,
      redemptionRules: redemptionRules ?? {
        allowedModes,
        prematureClosureAllowed: true,
        lockInMonths: 0,
        prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
      },
      benefit: benefitDef ?? { type: "TEXT_ONLY", displayLabel: "Gift" },
    },
    valueBasis: ValueBasis.CASH,
    paymentPattern: "FIXED",
    status,
    ...(status === SchemeStatus.MATURED
      ? buildEligibleMaturedFixedSchemeFields({
          totalPaidPaise: paid,
          startDate: "2020-01-01",
          maturityDate: "2025-01-01",
        })
      : {
          startDate: "2020-01-01",
          maturityDate: "2030-12-01",
          installmentAmountPaise: paid,
          installments: [],
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

async function seedGoldWeightScheme({
  weightMg,
  amountPaise,
  status = SchemeStatus.MATURED,
  goldRules = { weightRoundingMode: "HALF_UP", weightPrecisionMg: 1 },
  redemptionRules,
  benefitDef,
}) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-GW5-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      valueBasis: ValueBasis.GOLD_WEIGHT,
      goldRules,
      redemptionRules: redemptionRules ?? {
        allowedModes: [RedemptionMode.CASH, RedemptionMode.GOLD_HANDOVER, RedemptionMode.PURCHASE_ADJUSTMENT],
        prematureClosureAllowed: true,
        lockInMonths: 0,
        prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
      },
      benefit: benefitDef ?? { type: "TEXT_ONLY", displayLabel: "Gift" },
    },
    valueBasis: ValueBasis.GOLD_WEIGHT,
    paymentPattern: "FIXED",
    status,
    ...(status === SchemeStatus.MATURED
      ? buildEligibleMaturedFixedSchemeFields({
          totalPaidPaise: amountPaise,
          startDate: "2020-01-01",
          maturityDate: "2025-01-01",
        })
      : {
          startDate: "2020-01-01",
          maturityDate: "2030-12-01",
          installmentAmountPaise: amountPaise,
          installments: [],
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
    description: "Gold paid",
  });
  await Scheme.updateOne({ _id: scheme._id }, { $set: { ledgerNextSequence: 1 } });
  return { tenant, branch, user, customer, scheme, weightMg, amountPaise };
}

async function approveAndComplete({ user, scheme, redemptionId, completeBody = {} }) {
  const row = await Redemption.findById(redemptionId).lean();
  if (row.status === RedemptionStatus.PENDING_APPROVAL || row.status === RedemptionStatus.REQUESTED) {
    await transitionRedemption(adminReq({ user, scheme, redemptionId }), "approve");
  }
  await transitionRedemption(adminReq({ user, scheme, redemptionId, body: completeBody }), "complete");
}

async function setTodayRate({ user, tenant, branch, ratePerGramPaise }) {
  const day = today();
  await setGoldRate({
    auth: { id: user._id, tenantId: tenant._id },
    headers: { "user-agent": "test" },
    body: { effectiveDate: day, ratePerGramPaise, branchId: branch._id },
  });
  return day;
}

test("gold-weight settlement preview without mode is rejected", async () => {
  const { scheme, user } = await seedGoldWeightScheme({ weightMg: 500, amountPaise: 250_000 });
  await assert.rejects(
    () => settlementPreview(previewReq(scheme, user), ClosureType.MATURITY_REDEMPTION),
    (error) => error.code === "REDEMPTION_MODE_REQUIRED",
  );
});

test("gold-weight preview rejects mode not allowed by plan", async () => {
  const { scheme, user } = await seedGoldWeightScheme({
    weightMg: 500,
    amountPaise: 250_000,
    redemptionRules: {
      allowedModes: [RedemptionMode.CASH],
      prematureClosureAllowed: false,
    },
  });
  await assert.rejects(
    () => settlementPreview(
      previewReq(scheme, user, { mode: RedemptionMode.GOLD_HANDOVER }),
      ClosureType.MATURITY_REDEMPTION,
    ),
    (error) => error.code === "REDEMPTION_MODE_NOT_ALLOWED",
  );
});

test("preferredMode alias persists mode and full settlement snapshot on customer request", async () => {
  const { tenant, branch, user, customer, scheme } = await seedGoldWeightScheme({
    weightMg: 600,
    amountPaise: 300_000,
    redemptionRules: { allowedModes: [RedemptionMode.GOLD_HANDOVER], prematureClosureAllowed: false },
  });
  await setTodayRate({ user, tenant, branch, ratePerGramPaise: 500_000 });
  const result = await requestCustomerRedemption({
    auth: { id: customer._id, tenantId: tenant._id, type: "CUSTOMER" },
    scope: { tenantId: tenant._id },
    params: { schemeId: scheme._id },
    body: {
      preferredMode: RedemptionMode.GOLD_HANDOVER,
      expectedVersion: scheme.version,
    },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  });
  const row = await Redemption.findById(result.id).lean();
  assert.equal(row.mode, RedemptionMode.GOLD_HANDOVER);
  for (const key of SETTLEMENT_SNAPSHOT_FIELD_KEYS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(row.modeDetails.settlementSnapshot, key),
      `missing snapshot field ${key}`,
    );
  }
});

test("completion rejects missing settlement snapshot", async () => {
  const { user, scheme, paid } = await seedCashScheme({ paid: 200_000 });
  const row = await Redemption.create({
    _id: createId("red"),
    tenantId: scheme.tenantId,
    branchId: scheme.branchId,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    closureType: ClosureType.MATURITY_REDEMPTION,
    mode: RedemptionMode.CASH,
    status: RedemptionStatus.APPROVED,
    settlementPaise: paid,
    principalPaise: paid,
    version: 1,
    modeDetails: {},
  });
  await assert.rejects(
    () => transitionRedemption(adminReq({ user, scheme, redemptionId: row._id }), "complete"),
    (error) => error.code === "SETTLEMENT_SNAPSHOT_REQUIRED",
  );
});

test("completion rejects body mode different from approved request", async () => {
  const { user, scheme } = await seedCashScheme({
    paid: 200_000,
    allowedModes: [RedemptionMode.CASH, RedemptionMode.GOLD_HANDOVER],
  });
  const preview = await settlementPreview(
    previewReq(scheme, user, { mode: RedemptionMode.CASH }),
    ClosureType.MATURITY_REDEMPTION,
  );
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
    modeDetails: {
      settlementSnapshot: buildSettlementSnapshotFromPreview(
        preview,
        scheme.version,
        RedemptionMode.CASH,
      ),
    },
  });
  await assert.rejects(
    () => transitionRedemption(
      adminReq({
        user,
        scheme,
        redemptionId: row._id,
        body: { mode: RedemptionMode.GOLD_HANDOVER },
      }),
      "complete",
    ),
    (error) => error.code === "REDEMPTION_MODE_NOT_ALLOWED",
  );
});

const cashMatrix = [
  { name: "mature CASH", mode: RedemptionMode.CASH, closure: ClosureType.MATURITY_REDEMPTION, paid: 300_000 },
  {
    name: "mature GOLD_HANDOVER",
    mode: RedemptionMode.GOLD_HANDOVER,
    closure: ClosureType.MATURITY_REDEMPTION,
    paid: 300_000,
    allowedModes: [RedemptionMode.CASH, RedemptionMode.GOLD_HANDOVER],
    needsRate: true,
  },
  {
    name: "premature FORFEIT CASH",
    mode: RedemptionMode.CASH,
    closure: ClosureType.PREMATURE_CLOSURE,
    paid: 300_000,
    rules: {
      allowedModes: [RedemptionMode.CASH],
      prematureClosureAllowed: true,
      lockInMonths: 0,
      prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
    },
    benefit: { type: "FIXED_BONUS_AMOUNT", bonusBasis: "FLAT", bonusValue: 50_000 },
    status: SchemeStatus.ACTIVE,
    ack: { acknowledgeBenefitForfeit: true },
  },
  {
    name: "premature FULL CASH",
    mode: RedemptionMode.CASH,
    closure: ClosureType.PREMATURE_CLOSURE,
    paid: 300_000,
    rules: {
      allowedModes: [RedemptionMode.CASH],
      prematureClosureAllowed: true,
      lockInMonths: 0,
      prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FULL" },
    },
    benefit: { type: "FIXED_BONUS_AMOUNT", bonusBasis: "FLAT", bonusValue: 50_000 },
    status: SchemeStatus.ACTIVE,
  },
  {
    name: "flat penalty",
    mode: RedemptionMode.CASH,
    closure: ClosureType.PREMATURE_CLOSURE,
    paid: 300_000,
    rules: {
      allowedModes: [RedemptionMode.CASH],
      prematureClosureAllowed: true,
      lockInMonths: 0,
      prematurePenalty: { mode: "FLAT", flatPaise: 20_000, benefitTreatment: "FORFEIT" },
    },
    status: SchemeStatus.ACTIVE,
    ack: { acknowledgeBenefitForfeit: true, acknowledgePenalty: true },
  },
  {
    name: "percentage penalty",
    mode: RedemptionMode.CASH,
    closure: ClosureType.PREMATURE_CLOSURE,
    paid: 300_000,
    rules: {
      allowedModes: [RedemptionMode.CASH],
      prematureClosureAllowed: true,
      lockInMonths: 0,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 10, benefitTreatment: "FORFEIT" },
    },
    status: SchemeStatus.ACTIVE,
    ack: { acknowledgeBenefitForfeit: true, acknowledgePenalty: true },
  },
  {
    name: "fixed benefit mature",
    mode: RedemptionMode.CASH,
    closure: ClosureType.MATURITY_REDEMPTION,
    paid: 300_000,
    benefit: {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "FLAT",
      bonusValue: 25_000,
      eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
    },
  },
  {
    name: "percent benefit with cap",
    mode: RedemptionMode.CASH,
    closure: ClosureType.MATURITY_REDEMPTION,
    paid: 400_000,
    benefit: {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "PERCENT_OF_PAID",
      bonusValue: 10,
      maxBonusPaise: 25_000,
      eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
    },
  },
];

for (const row of cashMatrix) {
  test(`cash plan persisted completion: ${row.name}`, async () => {
    const { user, scheme, paid } = await seedCashScheme({
      paid: row.paid,
      status: row.status ?? SchemeStatus.MATURED,
      benefitDef: row.benefit,
      redemptionRules: row.rules,
      allowedModes: row.allowedModes ?? [RedemptionMode.CASH],
    });
    if (row.needsRate) {
      await setTodayRate({
        user,
        tenant: { _id: scheme.tenantId },
        branch: { _id: scheme.branchId },
        ratePerGramPaise: 500_000,
      });
    }
    const initiated = await initiateRedemption(
      {
        auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
        scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
        params: { schemeId: scheme._id },
        body: {
          mode: row.mode,
          expectedVersion: scheme.version,
          modeDetails: row.ack ?? {},
        },
        query: {},
        headers: {},
        ip: "127.0.0.1",
      },
      row.closure,
    );
    await approveAndComplete({ user, scheme, redemptionId: initiated._id });
    const completed = await Redemption.findById(initiated._id).lean();
    assert.equal(completed.status, RedemptionStatus.COMPLETED);
    assert.equal(completed.mode, row.mode);
    const debit = await LedgerEntry.findOne({
      schemeId: scheme._id,
      type: LedgerEntryType.REDEMPTION_DEBIT,
    }).lean();
    assert.ok(debit);
    assert.equal(debit.amountPaise, completed.settlementPaise);
    if (row.mode === RedemptionMode.CASH) {
      assert.equal(completed.cashOutPaise, completed.settlementPaise);
    }
    if (row.name === "flat penalty") {
      assert.equal(completed.penaltyPaise, 20_000);
    }
    if (row.name === "percentage penalty") {
      assert.equal(completed.penaltyPaise, 30_000);
    }
    if (row.name === "premature FULL CASH") {
      assert.equal(completed.benefitPaise, 50_000);
      assert.equal(completed.settlementPaise, paid + 50_000);
    }
    if (row.name === "premature FORFEIT CASH") {
      assert.equal(completed.benefitPaise, 0);
      assert.equal(completed.settlementPaise, paid);
    }
  });
}

test("cash plan gold handover blocked when exact-day rate missing", async () => {
  const { user, scheme } = await seedCashScheme({
    paid: 300_000,
    allowedModes: [RedemptionMode.CASH, RedemptionMode.GOLD_HANDOVER],
  });
  await assert.rejects(
    () =>
      initiateRedemption(
        {
          auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
          scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
          params: { schemeId: scheme._id },
          body: { mode: RedemptionMode.GOLD_HANDOVER, expectedVersion: scheme.version },
          query: {},
          headers: {},
          ip: "127.0.0.1",
        },
        ClosureType.MATURITY_REDEMPTION,
      ),
    (error) => error.code === "GOLD_RATE_NOT_SET",
  );
});

test("gold-weight mature CASH completion persists cashOut from completion-day rate", async () => {
  const { tenant, branch, user, scheme, weightMg } = await seedGoldWeightScheme({
    weightMg: 500,
    amountPaise: 250_000,
  });
  await setTodayRate({ user, tenant, branch, ratePerGramPaise: 500_000 });
  const initiated = await initiateRedemption(
    {
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
      scope: { tenantId: tenant._id, branchId: branch._id },
      params: { schemeId: scheme._id },
      body: { mode: RedemptionMode.CASH, expectedVersion: scheme.version },
      query: {},
      headers: {},
      ip: "127.0.0.1",
    },
    ClosureType.MATURITY_REDEMPTION,
  );
  await approveAndComplete({ user, scheme, redemptionId: initiated._id });
  const completed = await Redemption.findById(initiated._id).lean();
  assert.equal(completed.cashOutPaise, 250_000);
  assert.equal(completed.weightMg, weightMg);
  const debit = await LedgerEntry.findOne({ schemeId: scheme._id, type: LedgerEntryType.REDEMPTION_DEBIT }).lean();
  assert.equal(debit.weightMg, weightMg);
  assert.equal(debit.amountPaise, 250_000);
});

test("gold-weight PURCHASE_ADJUSTMENT reporting and ledger metadata", async () => {
  const billNumber = "GW-BILL-9001";
  const { tenant, branch, user, customer, scheme } = await seedGoldWeightScheme({
    weightMg: 800,
    amountPaise: 400_000,
    redemptionRules: {
      allowedModes: [RedemptionMode.PURCHASE_ADJUSTMENT, RedemptionMode.CASH],
      prematureClosureAllowed: false,
    },
    benefitDef: {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "FLAT",
      bonusValue: 0,
      eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
    },
  });
  await setTodayRate({ user, tenant, branch, ratePerGramPaise: 500_000 });
  const requested = await requestCustomerRedemption({
    auth: { id: customer._id, tenantId: tenant._id, type: "CUSTOMER" },
    scope: { tenantId: tenant._id },
    params: { schemeId: scheme._id },
    body: {
      preferredMode: RedemptionMode.PURCHASE_ADJUSTMENT,
      expectedVersion: scheme.version,
      modeDetails: { billNumber },
    },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  });
  await approveAndComplete({
    user,
    scheme,
    redemptionId: requested.id,
    completeBody: { modeDetails: { billNumber } },
  });
  const completed = await Redemption.findById(requested.id).lean();
  assert.equal(completed.cashOutPaise, 0);
  assert.equal(completed.handoverValuePaise, 0);
  assert.equal(completed.modeDetails.billNumber, billNumber);
  assert.equal(completed.settlementPaise, 400_000);
  const debit = await LedgerEntry.findOne({
    schemeId: scheme._id,
    type: LedgerEntryType.REDEMPTION_DEBIT,
  }).lean();
  assert.equal(debit.metadata?.billNumber, billNumber);
  assert.equal(debit.amountPaise, 400_000);

  const summary = await redemptionPeriodSummary(
    { tenantId: tenant._id },
    { from: today(), to: today() },
  );
  assert.equal(summary.cashSettlementPaise, 0);
  assert.equal(summary.purchaseAdjustmentSettlementPaise, 400_000);
  assert.equal(summary.goldWeightMg, 0);
});

test("gold-weight only previous-day rate does not satisfy exact-day completion", async () => {
  const { tenant, branch, user, scheme } = await seedGoldWeightScheme({
    weightMg: 500,
    amountPaise: 250_000,
    redemptionRules: { allowedModes: [RedemptionMode.CASH], prematureClosureAllowed: false },
  });
  const day = today();
  await GoldRate.create({
    _id: createId("grt"),
    tenantId: tenant._id,
    branchId: branch._id,
    effectiveDate: "2020-01-01",
    ratePerGramPaise: 400_000,
    purity: "22K",
    enteredBy: user._id,
  });
  await setTodayRate({ user, tenant, branch, ratePerGramPaise: 500_000 });
  const initiated = await initiateRedemption(
    {
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
      scope: { tenantId: tenant._id, branchId: branch._id },
      params: { schemeId: scheme._id },
      body: { mode: RedemptionMode.CASH, expectedVersion: scheme.version },
      query: {},
      headers: {},
      ip: "127.0.0.1",
    },
    ClosureType.MATURITY_REDEMPTION,
  );
  await transitionRedemption(adminReq({ user, scheme, redemptionId: initiated._id }), "approve");
  await GoldRate.deleteMany({ tenantId: tenant._id, branchId: branch._id, effectiveDate: day });
  await assert.rejects(
    () => transitionRedemption(adminReq({ user, scheme, redemptionId: initiated._id }), "complete"),
    (error) => error.code === "GOLD_RATE_NOT_SET",
  );
  assert.equal(await LedgerEntry.countDocuments({ schemeId: scheme._id, type: LedgerEntryType.REDEMPTION_DEBIT }), 0);
});
