import test from "node:test";
import assert from "node:assert/strict";
import {
  CashSettlementBasis,
  ClosureType,
  LedgerEntryType,
  PaidAmountBenefitTreatment,
  RedemptionMode,
  RedemptionStatus,
  SchemeStatus,
  TenantRole,
  ValueBasis,
} from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { today } from "../src/lib/date.js";
import { LedgerEntry, Redemption, Scheme } from "../src/models/index.js";
import {
  buildSettlementSnapshotFromPreview,
} from "../src/lib/scheme-closure-settlement.js";
import { setGoldRate } from "../src/services/tenant.service.js";
import {
  initiateRedemption,
  settlementPreview,
  transitionRedemption,
} from "../src/services/redemption.service.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { buildEligibleMaturedFixedSchemeFields } from "./helpers/maturity-fixtures.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

const BONUS_PAISE = 25_000;

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
  amountPaise = 400_000,
  weightMg = 800,
  redemptionRules,
  benefit,
  status = SchemeStatus.MATURED,
}) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-CSM-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      valueBasis: ValueBasis.GOLD_WEIGHT,
      goldRules: { weightRoundingMode: "HALF_UP", weightPrecisionMg: 1 },
      redemptionRules,
      benefit: benefit ?? { type: "TEXT_ONLY", displayLabel: "Gift" },
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
    description: "Gold installment",
  });
  await Scheme.updateOne({ _id: scheme._id }, { $set: { ledgerNextSequence: 1 } });
  return { tenant, branch, user, customer, scheme, amountPaise, weightMg };
}

const paidAmountRules = (extra = {}) => ({
  allowedModes: [RedemptionMode.CASH],
  cashSettlementBasis: CashSettlementBasis.PAID_AMOUNT,
  paidAmountBenefitTreatment: PaidAmountBenefitTreatment.EXCLUDE,
  prematureClosureAllowed: true,
  lockInMonths: 0,
  prematurePenalty: {
    mode: "PERCENT_OF_PAID",
    value: 10,
    benefitTreatment: "FORFEIT",
  },
  ...extra,
});

test("PAID_AMOUNT preview uses net principal after ledger reversal", async () => {
  const amountPaise = 500_000;
  const reversalPaise = 100_000;
  const { tenant, branch, user, customer, scheme, weightMg } = await seedGoldMatured({
    amountPaise,
    weightMg: 1000,
    redemptionRules: paidAmountRules(),
  });
  await LedgerEntry.create({
    _id: createId("ledger"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    type: LedgerEntryType.REVERSAL,
    sequence: 2,
    amountPaise: reversalPaise,
    weightMg: 200,
    actorType: "USER",
    actorId: user._id,
    description: "Partial reversal",
  });
  const preview = await settlementPreview(
    previewReq({ user, scheme, mode: RedemptionMode.CASH }),
    ClosureType.MATURITY_REDEMPTION,
  );
  assert.equal(preview.principalPaise, amountPaise - reversalPaise);
  assert.equal(preview.settlementPaise, amountPaise - reversalPaise);
  assert.equal(preview.ledgerReleaseWeightMg ?? preview.weightMg, weightMg - 200);
});

test("PAID_AMOUNT premature FORFEIT: penalty paise, zero benefit paid, full weight debit", async () => {
  const amountPaise = 300_000;
  const weightMg = 600;
  const { tenant, branch, user, scheme } = await seedGoldMatured({
    amountPaise,
    weightMg,
    status: SchemeStatus.ACTIVE,
    redemptionRules: paidAmountRules(),
    benefit: {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "FLAT",
      bonusValue: BONUS_PAISE,
      eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
    },
  });
  const preview = await settlementPreview(
    previewReq({ user, scheme, mode: RedemptionMode.CASH }),
    ClosureType.PREMATURE_CLOSURE,
  );
  assert.equal(preview.penaltyPaise, 30_000);
  assert.equal(preview.includedBenefitPaise, 0);
  assert.equal(preview.settlementPaise, amountPaise - 30_000);
  const initiated = await initiateRedemption(
    {
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
      scope: { tenantId: tenant._id, branchId: branch._id },
      params: { schemeId: scheme._id },
      body: {
        mode: RedemptionMode.CASH,
        expectedVersion: scheme.version,
        modeDetails: {
          acknowledgeBenefitForfeit: true,
          acknowledgePenalty: true,
        },
      },
      query: {},
      headers: {},
      ip: "127.0.0.1",
    },
    ClosureType.PREMATURE_CLOSURE,
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
  if (initiated.status !== RedemptionStatus.APPROVED) {
    await transitionRedemption(completeReq, "approve");
  }
  await transitionRedemption(completeReq, "complete");
  const debit = await LedgerEntry.findOne({
    schemeId: scheme._id,
    type: LedgerEntryType.REDEMPTION_DEBIT,
  }).lean();
  assert.equal(debit.amountPaise, amountPaise - 30_000);
  assert.equal(debit.weightMg, weightMg);
  assert.equal(
    await LedgerEntry.countDocuments({ schemeId: scheme._id, type: LedgerEntryType.BENEFIT_CREDIT }),
    0,
  );
});

test("PAID_AMOUNT INCLUDE_MONETARY premature keeps monetary benefit in payout", async () => {
  const amountPaise = 200_000;
  const { user, scheme } = await seedGoldMatured({
    amountPaise,
    weightMg: 400,
    status: SchemeStatus.ACTIVE,
    redemptionRules: {
      ...paidAmountRules(),
      paidAmountBenefitTreatment: PaidAmountBenefitTreatment.INCLUDE_MONETARY,
      prematurePenalty: {
        mode: "PERCENT_OF_PAID",
        value: 5,
        benefitTreatment: "FULL",
      },
    },
    benefit: {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "FLAT",
      bonusValue: BONUS_PAISE,
      eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
    },
  });
  const preview = await settlementPreview(
    previewReq({ user, scheme, mode: RedemptionMode.CASH }),
    ClosureType.PREMATURE_CLOSURE,
  );
  assert.equal(preview.penaltyPaise, 10_000);
  assert.equal(preview.includedBenefitPaise, BONUS_PAISE);
  assert.equal(preview.settlementPaise, amountPaise - 10_000 + BONUS_PAISE);
});

test("approved redemption rejects completion after extra installment changes principal", async () => {
  const { tenant, branch, user, customer, scheme } = await seedGoldMatured({
    redemptionRules: paidAmountRules({ prematureClosureAllowed: false }),
  });
  const preview = await settlementPreview(
    previewReq({ user, scheme, mode: RedemptionMode.CASH }),
    ClosureType.MATURITY_REDEMPTION,
  );
  const snapshot = buildSettlementSnapshotFromPreview(
    preview,
    scheme.version,
    RedemptionMode.CASH,
  );
  const redemptionId = createId("redemption");
  await Redemption.create({
    _id: redemptionId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    closureType: ClosureType.MATURITY_REDEMPTION,
    mode: RedemptionMode.CASH,
    status: RedemptionStatus.APPROVED,
    settlementPaise: preview.settlementPaise,
    principalPaise: preview.principalPaise,
    weightMg: preview.weightMg,
    version: 1,
    modeDetails: { settlementSnapshot: snapshot },
  });
  await LedgerEntry.create({
    _id: createId("ledger"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    type: LedgerEntryType.INSTALLMENT_PAYMENT,
    sequence: 2,
    amountPaise: 50_000,
    weightMg: 100,
    actorType: "USER",
    actorId: user._id,
    description: "Late payment",
  });
  await assert.rejects(
    () => transitionRedemption(
      {
        auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
        scope: { tenantId: tenant._id, branchId: branch._id },
        params: { redemptionId },
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

test("GOLD_VALUE cash preview blocked without rate; PAID_AMOUNT still eligible", async () => {
  const amountPaise = 350_000;
  const { user, scheme } = await seedGoldMatured({
    amountPaise,
    redemptionRules: {
      allowedModes: [RedemptionMode.CASH],
      cashSettlementBasis: CashSettlementBasis.GOLD_VALUE,
      prematureClosureAllowed: false,
      lockInMonths: 0,
    },
  });
  const goldPreview = await settlementPreview(
    previewReq({ user, scheme, mode: RedemptionMode.CASH }),
    ClosureType.MATURITY_REDEMPTION,
  );
  assert.equal(goldPreview.eligible, false);
  assert.ok(goldPreview.blockers.some((b) => b.code === "GOLD_RATE_NOT_SET"));

  await Scheme.updateOne(
    { _id: scheme._id },
    {
      $set: {
        "planSnapshot.redemptionRules.cashSettlementBasis": CashSettlementBasis.PAID_AMOUNT,
      },
    },
  );
  const schemePaid = await Scheme.findById(scheme._id).lean();
  const paidPreview = await settlementPreview(
    previewReq({ user, scheme: schemePaid, mode: RedemptionMode.CASH }),
    ClosureType.MATURITY_REDEMPTION,
  );
  assert.equal(paidPreview.eligible, true);
  assert.equal(paidPreview.settlementPaise, amountPaise);

  const valuationDate = today();
  await setGoldRate({
    auth: { id: user._id, tenantId: scheme.tenantId },
    headers: { "user-agent": "test" },
    body: {
      effectiveDate: valuationDate,
      ratePerGramPaise: 600_000,
      branchId: scheme.branchId,
    },
  });
  await Scheme.updateOne(
    { _id: scheme._id },
    {
      $set: {
        "planSnapshot.redemptionRules.cashSettlementBasis": CashSettlementBasis.GOLD_VALUE,
      },
    },
  );
  const schemeGoldAgain = await Scheme.findById(scheme._id).lean();
  const goldWithRate = await settlementPreview(
    previewReq({ user, scheme: schemeGoldAgain, mode: RedemptionMode.CASH }),
    ClosureType.MATURITY_REDEMPTION,
  );
  assert.equal(goldWithRate.eligible, true);
  assert.ok(goldWithRate.settlementPaise > amountPaise);
});

test("legacy in-flight snapshot with tampered principal still rejected at completion", async () => {
  const { tenant, branch, user, customer, scheme } = await seedGoldMatured({
    redemptionRules: paidAmountRules({ prematureClosureAllowed: false }),
  });
  const preview = await settlementPreview(
    previewReq({ user, scheme, mode: RedemptionMode.CASH }),
    ClosureType.MATURITY_REDEMPTION,
  );
  const snapshot = buildSettlementSnapshotFromPreview(
    preview,
    scheme.version,
    RedemptionMode.CASH,
  );
  snapshot.principalPaise = preview.principalPaise - 1;
  const redemptionId = createId("redemption");
  await Redemption.create({
    _id: redemptionId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    closureType: ClosureType.MATURITY_REDEMPTION,
    mode: RedemptionMode.CASH,
    status: RedemptionStatus.APPROVED,
    settlementPaise: preview.settlementPaise,
    principalPaise: preview.principalPaise,
    weightMg: preview.weightMg,
    version: 1,
    modeDetails: { settlementSnapshot: snapshot },
  });
  await assert.rejects(
    () => transitionRedemption(
      {
        auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
        scope: { tenantId: tenant._id, branchId: branch._id },
        params: { redemptionId },
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
