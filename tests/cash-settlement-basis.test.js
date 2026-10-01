import test from "node:test";
import assert from "node:assert/strict";
import {
  CashSettlementBasis,
  ClosureType,
  LedgerEntryType,
  PaidAmountBenefitTreatment,
  RedemptionMode,
  SchemeStatus,
  TenantRole,
  ValueBasis,
} from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import {
  resolveCashSettlementBasisFromRedemptionRules,
} from "../src/lib/cash-settlement-basis.js";
import { buildSettlementSnapshotFromPreview } from "../src/lib/scheme-closure-settlement.js";
import { LedgerEntry, Redemption, Scheme } from "../src/models/index.js";
import {
  initiateRedemption,
  settlementPreview,
  transitionRedemption,
} from "../src/services/redemption.service.js";
import { today } from "../src/lib/date.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { buildEligibleMaturedFixedSchemeFields } from "./helpers/maturity-fixtures.js";
import { setGoldRate } from "../src/services/tenant.service.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function previewReq({ user, scheme, mode }) {
  return {
    auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
    scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
    params: { schemeId: scheme._id },
    body: { mode },
    query: {},
  };
}

async function seedGoldMatured({
  amountPaise = 300_000,
  weightMg = 600,
  redemptionRules,
  benefit,
}) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-CSB-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      valueBasis: ValueBasis.GOLD_WEIGHT,
      goldRules: { weightRoundingMode: "HALF_UP", weightPrecisionMg: 1 },
      redemptionRules: redemptionRules ?? {
        allowedModes: [RedemptionMode.CASH, RedemptionMode.GOLD_HANDOVER],
        prematureClosureAllowed: false,
        lockInMonths: 0,
      },
      benefit: benefit ?? { type: "TEXT_ONLY", displayLabel: "Gift" },
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
    description: "Gold installment",
  });
  await Scheme.updateOne({ _id: scheme._id }, { $set: { ledgerNextSequence: 1 } });
  return { tenant, branch, user, customer, scheme, amountPaise, weightMg };
}

test("legacy plan snapshot without cashSettlementBasis resolves to GOLD_VALUE", () => {
  assert.equal(
    resolveCashSettlementBasisFromRedemptionRules({ allowedModes: [RedemptionMode.CASH] }),
    CashSettlementBasis.GOLD_VALUE,
  );
});

test("PAID_AMOUNT CASH preview eligible without exact-day gold rate", async () => {
  const { user, customer, scheme, amountPaise } = await seedGoldMatured({
    redemptionRules: {
      allowedModes: [RedemptionMode.CASH],
      cashSettlementBasis: CashSettlementBasis.PAID_AMOUNT,
      prematureClosureAllowed: false,
      lockInMonths: 0,
    },
  });
  const preview = await settlementPreview(
    previewReq({ user, customer, scheme, mode: RedemptionMode.CASH }),
    ClosureType.MATURITY_REDEMPTION,
  );
  assert.equal(preview.eligible, true);
  assert.equal(preview.cashSettlementBasis, CashSettlementBasis.PAID_AMOUNT);
  assert.equal(preview.settlementPaise, amountPaise);
  assert.equal(preview.valuationRatePerGramPaise, 0);
  assert.ok(
    !preview.blockers.some((b) => b.code === "GOLD_RATE_NOT_SET"),
    "PAID_AMOUNT must not require gold rate for principal",
  );
});

test("GOLD_VALUE CASH preview blocked when exact-day rate missing", async () => {
  const { user, customer, scheme } = await seedGoldMatured({
    redemptionRules: {
      allowedModes: [RedemptionMode.CASH],
      cashSettlementBasis: CashSettlementBasis.GOLD_VALUE,
      prematureClosureAllowed: false,
      lockInMonths: 0,
    },
  });
  const preview = await settlementPreview(
    previewReq({ user, customer, scheme, mode: RedemptionMode.CASH }),
    ClosureType.MATURITY_REDEMPTION,
  );
  assert.equal(preview.eligible, false);
  assert.ok(preview.blockers.some((b) => b.code === "GOLD_RATE_NOT_SET"));
});

test("PAID_AMOUNT INCLUDE_MONETARY adds computed benefit paise without gold rate", async () => {
  const bonusPaise = 25_000;
  const { user, customer, scheme, amountPaise } = await seedGoldMatured({
    redemptionRules: {
      allowedModes: [RedemptionMode.CASH],
      cashSettlementBasis: CashSettlementBasis.PAID_AMOUNT,
      paidAmountBenefitTreatment: PaidAmountBenefitTreatment.INCLUDE_MONETARY,
      prematureClosureAllowed: false,
      lockInMonths: 0,
    },
    benefit: {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "FLAT",
      bonusValue: bonusPaise,
      eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
    },
  });
  const preview = await settlementPreview(
    previewReq({ user, customer, scheme, mode: RedemptionMode.CASH }),
    ClosureType.MATURITY_REDEMPTION,
  );
  assert.equal(preview.settlementPaise, amountPaise + bonusPaise);
  assert.equal(preview.includedMonetaryBenefitPaise, bonusPaise);
});

test("PAID_AMOUNT completion debits full gold weight and pays net cash", async () => {
  const amountPaise = 400_000;
  const weightMg = 800;
  const { tenant, branch, user, customer, scheme } = await seedGoldMatured({
    amountPaise,
    weightMg,
    redemptionRules: {
      allowedModes: [RedemptionMode.CASH],
      cashSettlementBasis: CashSettlementBasis.PAID_AMOUNT,
      prematureClosureAllowed: false,
      lockInMonths: 0,
    },
  });
  const preview = await settlementPreview(
    previewReq({ user, customer, scheme, mode: RedemptionMode.CASH }),
    ClosureType.MATURITY_REDEMPTION,
  );
  const initiated = await initiateRedemption(
    {
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
      scope: { tenantId: tenant._id, branchId: branch._id },
      params: { schemeId: scheme._id },
      body: {
        mode: RedemptionMode.CASH,
        expectedVersion: scheme.version,
        modeDetails: { expectedFinalValuePaise: preview.settlementPaise },
      },
      query: {},
      headers: {},
      ip: "127.0.0.1",
    },
    ClosureType.MATURITY_REDEMPTION,
  );
  const completeReq = {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { redemptionId: initiated._id },
    body: {},
    query: {},
    headers: {},
    ip: "127.0.0.1",
  };
  if (initiated.status !== "APPROVED") {
    await transitionRedemption(completeReq, "approve");
  }
  await transitionRedemption(completeReq, "complete");
  const debit = await LedgerEntry.findOne({
    schemeId: scheme._id,
    type: LedgerEntryType.REDEMPTION_DEBIT,
  }).lean();
  assert.equal(debit.amountPaise, amountPaise);
  assert.equal(debit.weightMg, weightMg);
  const closed = await Scheme.findById(scheme._id).lean();
  assert.equal(closed.status, SchemeStatus.REDEEMED);
});

test("completion rejects stale snapshot when basis tampered", async () => {
  const { tenant, branch, user, customer, scheme } = await seedGoldMatured({
    redemptionRules: {
      allowedModes: [RedemptionMode.CASH],
      cashSettlementBasis: CashSettlementBasis.PAID_AMOUNT,
      prematureClosureAllowed: false,
      lockInMonths: 0,
    },
  });
  const preview = await settlementPreview(
    previewReq({ user, customer, scheme, mode: RedemptionMode.CASH }),
    ClosureType.MATURITY_REDEMPTION,
  );
  const snapshot = buildSettlementSnapshotFromPreview(
    preview,
    scheme.version,
    RedemptionMode.CASH,
  );
  snapshot.cashSettlementBasis = CashSettlementBasis.GOLD_VALUE;
  const row = await Redemption.create({
    _id: createId("redemption"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    closureType: ClosureType.MATURITY_REDEMPTION,
    mode: RedemptionMode.CASH,
    status: "APPROVED",
    settlementPaise: preview.settlementPaise,
    principalPaise: preview.principalPaise,
    benefitPaise: 0,
    benefitWeightMg: 0,
    benefitRatePerGramPaise: 0,
    penaltyPaise: 0,
    penaltyWeightMg: 0,
    weightMg: preview.weightMg,
    modeDetails: { settlementSnapshot: snapshot },
    version: 1,
  });
  await assert.rejects(
    () => transitionRedemption(
      {
        auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
        scope: { tenantId: tenant._id, branchId: branch._id },
        params: { redemptionId: row._id },
        body: {},
        query: {},
        headers: {},
        ip: "127.0.0.1",
      },
      "complete",
    ),
    (err) => err.code === "SETTLEMENT_VALUE_CHANGED",
  );
});

test("GOLD_HANDOVER on PAID_AMOUNT plan still requires gold rate", async () => {
  const { user, customer, scheme } = await seedGoldMatured({
    redemptionRules: {
      allowedModes: [RedemptionMode.CASH, RedemptionMode.GOLD_HANDOVER],
      cashSettlementBasis: CashSettlementBasis.PAID_AMOUNT,
      prematureClosureAllowed: false,
      lockInMonths: 0,
    },
  });
  const preview = await settlementPreview(
    previewReq({ user, customer, scheme, mode: RedemptionMode.GOLD_HANDOVER }),
    ClosureType.MATURITY_REDEMPTION,
  );
  assert.equal(preview.eligible, false);
  assert.ok(preview.blockers.some((b) => b.code === "GOLD_RATE_NOT_SET"));
});

test("PAID_AMOUNT EXCLUDE does not post BENEFIT_CREDIT at completion", async () => {
  const bonusPaise = 30_000;
  const { tenant, branch, user, customer, scheme } = await seedGoldMatured({
    redemptionRules: {
      allowedModes: [RedemptionMode.CASH],
      cashSettlementBasis: CashSettlementBasis.PAID_AMOUNT,
      paidAmountBenefitTreatment: PaidAmountBenefitTreatment.EXCLUDE,
      prematureClosureAllowed: false,
      lockInMonths: 0,
    },
    benefit: {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "FLAT",
      bonusValue: bonusPaise,
      eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
    },
  });
  const preview = await settlementPreview(
    previewReq({ user, customer, scheme, mode: RedemptionMode.CASH }),
    ClosureType.MATURITY_REDEMPTION,
  );
  assert.equal(preview.benefitPaise, bonusPaise);
  assert.equal(preview.settlementPaise, preview.principalPaise);
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
  const completeReq = {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { redemptionId: initiated._id },
    body: {},
    query: {},
    headers: {},
    ip: "127.0.0.1",
  };
  if (initiated.status !== "APPROVED") await transitionRedemption(completeReq, "approve");
  await transitionRedemption(completeReq, "complete");
  assert.equal(
    await LedgerEntry.countDocuments({ schemeId: scheme._id, type: LedgerEntryType.BENEFIT_CREDIT }),
    0,
  );
});

test("different gold rates change GOLD_VALUE cash but not PAID_AMOUNT", async () => {
  const amountPaise = 500_000;
  const weightMg = 1000;
  const { tenant, branch, user, customer, scheme } = await seedGoldMatured({
    amountPaise,
    weightMg,
    redemptionRules: {
      allowedModes: [RedemptionMode.CASH],
      cashSettlementBasis: CashSettlementBasis.PAID_AMOUNT,
      prematureClosureAllowed: false,
      lockInMonths: 0,
    },
  });
  const paidPreview = await settlementPreview(
    previewReq({ user, customer, scheme, mode: RedemptionMode.CASH }),
    ClosureType.MATURITY_REDEMPTION,
  );
  assert.equal(paidPreview.settlementPaise, amountPaise);
  await setGoldRate({
    auth: { id: user._id, tenantId: tenant._id },
    headers: { "user-agent": "test" },
    body: { effectiveDate: today(), ratePerGramPaise: 600_000, branchId: branch._id },
  });
  const paidAfterRate = await settlementPreview(
    previewReq({ user, customer, scheme, mode: RedemptionMode.CASH }),
    ClosureType.MATURITY_REDEMPTION,
  );
  assert.equal(paidAfterRate.settlementPaise, amountPaise);

  await Scheme.updateOne(
    { _id: scheme._id },
    {
      $set: {
        "planSnapshot.redemptionRules.cashSettlementBasis": CashSettlementBasis.GOLD_VALUE,
      },
    },
  );
  const schemeGoldValue = await Scheme.findById(scheme._id).lean();
  const goldPreview = await settlementPreview(
    previewReq({ user, customer, scheme: schemeGoldValue, mode: RedemptionMode.CASH }),
    ClosureType.MATURITY_REDEMPTION,
  );
  assert.ok(goldPreview.settlementPaise > amountPaise);
});
