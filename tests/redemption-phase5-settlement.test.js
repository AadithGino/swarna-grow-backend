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
  SchemeStatus,
  TenantRole,
} from "../src/constants/enums.js";
import {
  buildSettlementSnapshotFromPreview,
  computeGoldWeightModeSettlement,
  convertBenefitPaiseToWeightMg,
} from "../src/lib/scheme-closure-settlement.js";
import { computeClosurePenaltyPaise } from "../src/lib/scheme-closure-penalty.js";
import { decimalRoundingMode } from "../src/lib/money.js";
import { setGoldRate } from "../src/services/tenant.service.js";
import {
  initiateRedemption,
  settlementPreview,
  transitionRedemption,
} from "../src/services/redemption.service.js";
import { today } from "../src/lib/date.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("computeClosurePenaltyPaise uses net paid principal only", () => {
  const rule = { mode: "PERCENT_OF_PAID", value: 10 };
  assert.equal(
    computeClosurePenaltyPaise(rule, 300_000, { isPremature: true, systemPolicyClosure: false }),
    30_000,
  );
  assert.equal(
    computeClosurePenaltyPaise(rule, 300_000, { isPremature: true, systemPolicyClosure: true }),
    0,
  );
});

test("gold-weight handover subtracts penalty weight from handover", () => {
  const rounding = decimalRoundingMode("HALF_UP");
  const result = computeGoldWeightModeSettlement({
    mode: RedemptionMode.GOLD_HANDOVER,
    principalWeightMg: 600,
    benefitWeightMg: 100,
    penaltyPaise: 52_000,
    ratePerGramPaise: 520_000,
    rounding,
    precisionMg: 1,
  });
  assert.equal(result.penaltyWeightMg, 100);
  assert.equal(result.finalHandoverWeightMg, 600);
  assert.ok(result.handoverValuePaise > 0);
});

test("gold-weight cash values eligible weight at completion rate minus penalty once", () => {
  const rounding = decimalRoundingMode("HALF_UP");
  const result = computeGoldWeightModeSettlement({
    mode: RedemptionMode.CASH,
    principalWeightMg: 500,
    benefitWeightMg: 0,
    penaltyPaise: 10_000,
    ratePerGramPaise: 500_000,
    rounding,
    precisionMg: 1,
  });
  assert.equal(result.cashOutPaise, 250_000 - 10_000);
  assert.equal(result.handoverValuePaise, 0);
});

async function seedGoldWeightPrematureHandover({
  penaltyMode,
  penaltyValue,
  benefitTreatment,
  principalWeightMg = 1000,
  amountPaise = 500_000,
}) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-P5-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      valueBasis: "GOLD_WEIGHT",
      goldRules: { weightRoundingMode: "HALF_UP", weightPrecisionMg: 1 },
      redemptionRules: {
        allowedModes: [RedemptionMode.GOLD_HANDOVER, RedemptionMode.CASH],
        prematureClosureAllowed: true,
        lockInMonths: 0,
        prematurePenalty: {
          mode: penaltyMode,
          value: penaltyValue,
          flatPaise: penaltyValue,
          benefitTreatment,
        },
      },
      benefit: {
        type: "FIXED_BONUS_AMOUNT",
        bonusBasis: "FLAT",
        bonusValue: 50_000,
        eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
      },
    },
    valueBasis: "GOLD_WEIGHT",
    paymentPattern: "FIXED",
    status: SchemeStatus.ACTIVE,
    startDate: "2020-01-01",
    maturityDate: "2030-12-01",
    installmentAmountPaise: amountPaise,
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
    amountPaise,
    weightMg: principalWeightMg,
    actorType: "USER",
    actorId: user._id,
    description: "Gold paid",
  });
  await Scheme.updateOne({ _id: scheme._id }, { $set: { ledgerNextSequence: 1 } });
  return { tenant, branch, user, customer, scheme, principalWeightMg };
}

test("premature gold handover persists penalty weight and reduces handed-over weight", async () => {
  const { tenant, branch, user, scheme, principalWeightMg } =
    await seedGoldWeightPrematureHandover({
      penaltyMode: "FLAT",
      penaltyValue: 52_000,
      benefitTreatment: "FORFEIT",
    });
  const day = today();
  await setGoldRate({
    auth: { id: user._id, tenantId: tenant._id },
    headers: { "user-agent": "test" },
    body: { effectiveDate: day, ratePerGramPaise: 520_000, branchId: branch._id },
  });
  const previewReq = {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { schemeId: scheme._id },
    body: { mode: RedemptionMode.GOLD_HANDOVER },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  };
  const preview = await settlementPreview(previewReq, ClosureType.PREMATURE_CLOSURE);
  assert.equal(preview.penaltyPaise, 52_000);
  assert.ok(preview.penaltyWeightMg > 0);
  assert.equal(preview.weightMg, principalWeightMg - preview.penaltyWeightMg);

  const initiated = await initiateRedemption(
    {
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
      scope: { tenantId: tenant._id, branchId: branch._id },
      params: { schemeId: scheme._id },
      body: {
        mode: RedemptionMode.GOLD_HANDOVER,
        expectedVersion: scheme.version,
        modeDetails: { acknowledgeBenefitForfeit: true, acknowledgePenalty: true },
      },
      query: {},
      headers: {},
      ip: "127.0.0.1",
    },
    ClosureType.PREMATURE_CLOSURE,
  );
  await transitionRedemption({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { redemptionId: initiated._id },
    body: {},
    query: {},
    headers: {},
    ip: "127.0.0.1",
  }, "approve");
  await transitionRedemption({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { redemptionId: initiated._id },
    body: {},
    query: {},
    headers: {},
    ip: "127.0.0.1",
  }, "complete");

  const completed = await Redemption.findById(initiated._id).lean();
  assert.equal(completed.penaltyWeightMg, preview.penaltyWeightMg);
  assert.equal(completed.weightMg, preview.weightMg);
  assert.equal(completed.handoverRateEffectiveDate, day);
  const penaltyEntry = await LedgerEntry.findOne({
    schemeId: scheme._id,
    type: LedgerEntryType.CLOSURE_PENALTY,
  }).lean();
  assert.equal(penaltyEntry.weightMg, completed.penaltyWeightMg);
  const debit = await LedgerEntry.findOne({
    schemeId: scheme._id,
    type: LedgerEntryType.REDEMPTION_DEBIT,
  }).lean();
  assert.equal(debit.weightMg, completed.weightMg);
  assert.notEqual(debit.weightMg, principalWeightMg);
});

test("completion rejects when exact-day rate missing before ledger writes", async () => {
  const { tenant, branch, user, scheme } = await seedGoldWeightPrematureHandover({
    penaltyMode: "NONE",
    penaltyValue: 0,
    benefitTreatment: "FORFEIT",
    principalWeightMg: 600,
  });
  const day = today();
  await setGoldRate({
    auth: { id: user._id, tenantId: tenant._id },
    headers: { "user-agent": "test" },
    body: { effectiveDate: day, ratePerGramPaise: 500_000, branchId: branch._id },
  });
  const initiated = await initiateRedemption(
    {
      auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
      scope: { tenantId: scheme.tenantId, branchId: branch._id },
      params: { schemeId: scheme._id },
      body: {
        mode: RedemptionMode.GOLD_HANDOVER,
        expectedVersion: scheme.version,
        modeDetails: { acknowledgeBenefitForfeit: true, acknowledgePenalty: true },
      },
      query: {},
      headers: {},
      ip: "127.0.0.1",
    },
    ClosureType.PREMATURE_CLOSURE,
  );
  await GoldRate.deleteMany({
    tenantId: tenant._id,
    branchId: branch._id,
    effectiveDate: day,
  });
  await transitionRedemption({
    auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
    scope: { tenantId: scheme.tenantId, branchId: branch._id },
    params: { redemptionId: initiated._id },
    body: {},
    query: {},
    headers: {},
    ip: "127.0.0.1",
  }, "approve");
  await assert.rejects(
    () => transitionRedemption({
      auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
      scope: { tenantId: scheme.tenantId, branchId: branch._id },
      params: { redemptionId: initiated._id },
      body: {},
      query: {},
      headers: {},
      ip: "127.0.0.1",
    }, "complete"),
    (error) => error.code === "GOLD_RATE_NOT_SET",
  );
  assert.equal(
    (await LedgerEntry.countDocuments({ schemeId: scheme._id, type: LedgerEntryType.REDEMPTION_DEBIT })),
    0,
  );
});

test("SETTLEMENT_VALUE_CHANGED when completion-day rate differs from request day", async () => {
  const { tenant, branch, user, scheme } = await seedGoldWeightPrematureHandover({
    penaltyMode: "NONE",
    penaltyValue: 0,
    benefitTreatment: "FULL",
    principalWeightMg: 500,
    amountPaise: 250_000,
  });
  const day = today();
  await setGoldRate({
    auth: { id: user._id, tenantId: tenant._id },
    headers: { "user-agent": "test" },
    body: { effectiveDate: day, ratePerGramPaise: 400_000, branchId: branch._id },
  });
  const previewAtRequest = await settlementPreview({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { schemeId: scheme._id },
    body: { mode: RedemptionMode.CASH },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  }, ClosureType.PREMATURE_CLOSURE);
  assert.ok(previewAtRequest.settlementPaise > 0);

  await setGoldRate({
    auth: { id: user._id, tenantId: tenant._id },
    headers: { "user-agent": "test" },
    body: { effectiveDate: day, ratePerGramPaise: 600_000, branchId: branch._id },
  });

  const row = await Redemption.create({
    _id: createId("red"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    closureType: ClosureType.PREMATURE_CLOSURE,
    mode: RedemptionMode.CASH,
    status: "APPROVED",
    principalPaise: previewAtRequest.principalPaise,
    benefitPaise: previewAtRequest.benefitPaise,
    benefitWeightMg: previewAtRequest.benefitWeightMg,
    benefitRatePerGramPaise: previewAtRequest.benefitRatePerGramPaise,
    penaltyPaise: previewAtRequest.penaltyPaise,
    penaltyWeightMg: previewAtRequest.penaltyWeightMg,
    settlementPaise: previewAtRequest.settlementPaise,
    weightMg: previewAtRequest.weightMg,
    version: 1,
    modeDetails: {
      settlementSnapshot: buildSettlementSnapshotFromPreview(previewAtRequest, scheme.version),
    },
  });

  await assert.rejects(
    () => transitionRedemption({
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
      scope: { tenantId: tenant._id, branchId: branch._id },
      params: { redemptionId: row._id },
      body: {},
      query: {},
      headers: {},
      ip: "127.0.0.1",
    }, "complete"),
    (error) => error.code === "SETTLEMENT_VALUE_CHANGED",
  );
});

test("benefit weight rounding ROUND_DOWN UP HALF_UP", () => {
  const rate = 500_000;
  const benefitPaise = 123_456;
  const down = convertBenefitPaiseToWeightMg(
    benefitPaise,
    rate,
    decimalRoundingMode("ROUND_DOWN"),
    100,
  );
  const up = convertBenefitPaiseToWeightMg(
    benefitPaise,
    rate,
    decimalRoundingMode("ROUND_UP"),
    100,
  );
  const half = convertBenefitPaiseToWeightMg(
    benefitPaise,
    rate,
    decimalRoundingMode("HALF_UP"),
    100,
  );
  assert.equal(down, 200);
  assert.equal(up, 300);
  assert.equal(half, 200);
});
