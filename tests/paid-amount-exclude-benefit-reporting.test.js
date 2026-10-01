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
import { setGoldRate } from "../src/services/tenant.service.js";
import {
  initiateRedemption,
  settlementPreview,
  transitionRedemption,
} from "../src/services/redemption.service.js";
import { buildMaturityRedemptionReport } from "../src/services/report-builders/maturity-redemption.report.js";
import { redemptionPeriodSummary } from "../src/services/redemption-period-summary.js";
import { getRedemptionForAdmin } from "../src/services/redemption.service.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { buildEligibleMaturedFixedSchemeFields } from "./helpers/maturity-fixtures.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

const BONUS_PAISE = 50_000;
const PRINCIPAL_PAISE = 400_000;
const WEIGHT_MG = 800;

async function seedMaturedGoldWeight({
  cashSettlementBasis = CashSettlementBasis.PAID_AMOUNT,
  paidAmountBenefitTreatment = PaidAmountBenefitTreatment.EXCLUDE,
} = {}) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-PEX-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      valueBasis: ValueBasis.GOLD_WEIGHT,
      goldRules: { weightRoundingMode: "HALF_UP", weightPrecisionMg: 1 },
      redemptionRules: {
        allowedModes: [RedemptionMode.CASH],
        cashSettlementBasis,
        paidAmountBenefitTreatment,
        prematureClosureAllowed: false,
        lockInMonths: 0,
      },
      benefit: {
        type: "FIXED_BONUS_AMOUNT",
        bonusBasis: "FLAT",
        bonusValue: BONUS_PAISE,
        eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
      },
    },
    valueBasis: ValueBasis.GOLD_WEIGHT,
    paymentPattern: "FIXED",
    status: SchemeStatus.MATURED,
    ...buildEligibleMaturedFixedSchemeFields({
      totalPaidPaise: PRINCIPAL_PAISE,
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
    amountPaise: PRINCIPAL_PAISE,
    weightMg: WEIGHT_MG,
    actorType: "USER",
    actorId: user._id,
    description: "Gold installment",
  });
  await Scheme.updateOne({ _id: scheme._id }, { $set: { ledgerNextSequence: 1 } });
  return { tenant, branch, user, customer, scheme };
}

async function completeCashRedemption({ tenant, branch, user, scheme }) {
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
  return initiated._id;
}

test("PAID_AMOUNT EXCLUDE: zero benefit paid in ledger, redemption, report, and detail", async () => {
  const { tenant, branch, user, scheme } = await seedMaturedGoldWeight();
  const preview = await settlementPreview(
    {
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
      scope: { tenantId: tenant._id, branchId: branch._id },
      params: { schemeId: scheme._id },
      body: { mode: RedemptionMode.CASH },
      query: {},
    },
    ClosureType.MATURITY_REDEMPTION,
  );
  assert.equal(preview.calculatedBenefitPaise, BONUS_PAISE);
  assert.equal(preview.includedBenefitPaise, 0);
  assert.equal(preview.settlementPaise, PRINCIPAL_PAISE);

  const redemptionId = await completeCashRedemption({ tenant, branch, user, scheme });

  const completed = await Redemption.findById(redemptionId).lean();
  assert.equal(completed.calculatedBenefitPaise, BONUS_PAISE);
  assert.equal(completed.includedBenefitPaise, 0);
  assert.equal(completed.benefitPaise, 0);
  assert.equal(completed.settlementPaise, PRINCIPAL_PAISE);
  assert.equal(completed.cashOutPaise, PRINCIPAL_PAISE);

  assert.equal(
    await LedgerEntry.countDocuments({
      schemeId: scheme._id,
      type: LedgerEntryType.BENEFIT_CREDIT,
    }),
    0,
  );
  const debit = await LedgerEntry.findOne({
    schemeId: scheme._id,
    type: LedgerEntryType.REDEMPTION_DEBIT,
  }).lean();
  assert.equal(debit.amountPaise, PRINCIPAL_PAISE);
  assert.equal(debit.weightMg, WEIGHT_MG);

  const detail = await getRedemptionForAdmin({
    params: { redemptionId: redemptionId },
    scope: { tenantId: tenant._id, branchId: branch._id },
  });
  assert.equal(detail.includedBenefitPaise, 0);
  assert.equal(detail.calculatedBenefitPaise, BONUS_PAISE);
  assert.equal(detail.benefitExcludedFromPayout, true);

  const summary = await redemptionPeriodSummary({ tenantId: tenant._id });
  assert.equal(summary.benefitPaise, 0);

  const report = await buildMaturityRedemptionReport({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    query: { period: "ALL" },
  });
  const reportRow = report.rows.find((r) => r.key === redemptionId);
  assert.ok(reportRow);
  assert.equal(reportRow.benefitPaid.amountPaise, 0);
  assert.equal(reportRow.calculatedBenefitPaise, BONUS_PAISE);
  assert.equal(reportRow.benefitExcludedFromPayout, true);
  const benefitSummary = report.summary.find((s) => s.key === "BENEFIT_PAID");
  assert.equal(benefitSummary.value.amountPaise, 0);
});

test("PAID_AMOUNT INCLUDE_MONETARY: benefit paid matches included benefit across surfaces", async () => {
  const { tenant, branch, user, scheme } = await seedMaturedGoldWeight({
    paidAmountBenefitTreatment: PaidAmountBenefitTreatment.INCLUDE_MONETARY,
  });
  const preview = await settlementPreview(
    {
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
      scope: { tenantId: tenant._id, branchId: branch._id },
      params: { schemeId: scheme._id },
      body: { mode: RedemptionMode.CASH },
      query: {},
    },
    ClosureType.MATURITY_REDEMPTION,
  );
  assert.equal(preview.includedBenefitPaise, BONUS_PAISE);
  assert.equal(preview.settlementPaise, PRINCIPAL_PAISE + BONUS_PAISE);

  const redemptionId = await completeCashRedemption({ tenant, branch, user, scheme });
  const completed = await Redemption.findById(redemptionId).lean();
  assert.equal(completed.includedBenefitPaise, BONUS_PAISE);
  assert.equal(completed.benefitPaise, BONUS_PAISE);
  assert.equal(completed.settlementPaise, PRINCIPAL_PAISE + BONUS_PAISE);
  assert.equal(completed.cashOutPaise, PRINCIPAL_PAISE + BONUS_PAISE);

  assert.equal(
    await LedgerEntry.countDocuments({
      schemeId: scheme._id,
      type: LedgerEntryType.BENEFIT_CREDIT,
    }),
    1,
  );

  const summary = await redemptionPeriodSummary({ tenantId: tenant._id });
  assert.equal(summary.benefitPaise, BONUS_PAISE);

  const report = await buildMaturityRedemptionReport({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    query: { period: "ALL" },
  });
  const reportRow = report.rows.find((r) => r.key === redemptionId);
  assert.equal(reportRow.benefitPaid.amountPaise, BONUS_PAISE);
  assert.equal(reportRow.benefitExcludedFromPayout, false);
});

test("legacy GOLD_VALUE redemption without split benefit fields keeps benefit paid semantics", async () => {
  const { tenant, branch, user, customer, scheme } = await seedMaturedGoldWeight({
    cashSettlementBasis: CashSettlementBasis.GOLD_VALUE,
    paidAmountBenefitTreatment: PaidAmountBenefitTreatment.EXCLUDE,
  });
  const valuationDate = today();
  await setGoldRate({
    auth: { id: user._id, tenantId: tenant._id },
    headers: { "user-agent": "test" },
    body: { effectiveDate: valuationDate, ratePerGramPaise: 500_000, branchId: branch._id },
  });
  const redemptionId = createId("redemption");
  const legacyBenefitPaise = BONUS_PAISE;
  const cashOut = PRINCIPAL_PAISE + legacyBenefitPaise;
  await Redemption.create({
    _id: redemptionId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    closureType: ClosureType.MATURITY_REDEMPTION,
    mode: RedemptionMode.CASH,
    status: RedemptionStatus.COMPLETED,
    settlementPaise: cashOut,
    cashOutPaise: cashOut,
    principalPaise: PRINCIPAL_PAISE,
    benefitPaise: legacyBenefitPaise,
    penaltyPaise: 0,
    weightMg: WEIGHT_MG,
    completedAt: new Date(),
    version: 1,
    modeDetails: {
      settlementSnapshot: {
        mode: RedemptionMode.CASH,
        principalPaise: PRINCIPAL_PAISE,
        benefitPaise: legacyBenefitPaise,
        settlementPaise: cashOut,
        weightMg: WEIGHT_MG,
      },
    },
  });

  const summary = await redemptionPeriodSummary({ tenantId: tenant._id });
  assert.equal(summary.benefitPaise, legacyBenefitPaise);

  const report = await buildMaturityRedemptionReport({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    query: { period: "ALL" },
  });
  const reportRow = report.rows.find((r) => r.key === redemptionId);
  assert.equal(reportRow.benefitPaid.amountPaise, legacyBenefitPaise);
  assert.equal(reportRow.benefitExcludedFromPayout, false);

  const detail = await getRedemptionForAdmin({
    params: { redemptionId },
    scope: { tenantId: tenant._id, branchId: branch._id },
  });
  assert.equal(detail.includedBenefitPaise, legacyBenefitPaise);
  assert.equal(detail.benefitExcludedFromPayout, false);
});

function legacyPaidAmountExcludeSnapshot({
  principalPaise = PRINCIPAL_PAISE,
  weightMg = WEIGHT_MG,
  calculatedBenefitPaise = BONUS_PAISE,
}) {
  return {
    mode: RedemptionMode.CASH,
    schemeVersion: 1,
    systemPolicyClosure: false,
    closureReason: "",
    principalPaise,
    principalWeightMg: weightMg,
    benefitPaise: calculatedBenefitPaise,
    benefitWeightMg: 0,
    benefitRatePerGramPaise: 0,
    penaltyPaise: 0,
    penaltyWeightMg: 0,
    settlementPaise: principalPaise,
    goldWeightMg: weightMg,
    weightMg,
    valuationRatePerGramPaise: 0,
    valuationRateEffectiveDate: "",
    cashSettlementBasis: CashSettlementBasis.PAID_AMOUNT,
    paidAmountBenefitTreatment: PaidAmountBenefitTreatment.EXCLUDE,
    computedAt: new Date().toISOString(),
  };
}

test("legacy completed PAID_AMOUNT EXCLUDE: benefit paid zero, benefitPaise kept as calculated", async () => {
  const { tenant, branch, user, customer, scheme } = await seedMaturedGoldWeight();
  const redemptionId = createId("redemption");
  await Redemption.create({
    _id: redemptionId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    closureType: ClosureType.MATURITY_REDEMPTION,
    mode: RedemptionMode.CASH,
    status: RedemptionStatus.COMPLETED,
    settlementPaise: PRINCIPAL_PAISE,
    cashOutPaise: PRINCIPAL_PAISE,
    principalPaise: PRINCIPAL_PAISE,
    benefitPaise: BONUS_PAISE,
    penaltyPaise: 0,
    weightMg: WEIGHT_MG,
    completedAt: new Date(),
    version: 1,
    modeDetails: {
      settlementSnapshot: legacyPaidAmountExcludeSnapshot({}),
    },
  });

  const stored = await Redemption.findById(redemptionId).lean();
  assert.equal(stored.benefitPaise, BONUS_PAISE);

  const detail = await getRedemptionForAdmin({
    params: { redemptionId },
    scope: { tenantId: tenant._id, branchId: branch._id },
  });
  assert.equal(detail.includedBenefitPaise, 0);
  assert.equal(detail.calculatedBenefitPaise, BONUS_PAISE);
  assert.equal(detail.benefitExcludedFromPayout, true);

  const summary = await redemptionPeriodSummary({ tenantId: tenant._id });
  assert.equal(summary.benefitPaise, 0);

  const report = await buildMaturityRedemptionReport({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    query: { period: "ALL" },
  });
  const reportRow = report.rows.find((r) => r.key === redemptionId);
  assert.equal(reportRow.benefitPaid.amountPaise, 0);
  assert.equal(reportRow.calculatedBenefitPaise, BONUS_PAISE);
  const benefitSummary = report.summary.find((s) => s.key === "BENEFIT_PAID");
  assert.equal(benefitSummary.value.amountPaise, 0);
});

test("legacy in-flight PAID_AMOUNT EXCLUDE completes with normalized snapshot and zero benefit paid", async () => {
  const { tenant, branch, user, customer, scheme } = await seedMaturedGoldWeight();
  const preview = await settlementPreview(
    {
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
      scope: { tenantId: tenant._id, branchId: branch._id },
      params: { schemeId: scheme._id },
      body: { mode: RedemptionMode.CASH },
      query: {},
    },
    ClosureType.MATURITY_REDEMPTION,
  );
  const snapshot = legacyPaidAmountExcludeSnapshot({
    principalPaise: preview.principalPaise,
    weightMg: preview.weightMg,
  });
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
    benefitPaise: BONUS_PAISE,
    penaltyPaise: 0,
    weightMg: preview.weightMg,
    version: 1,
    modeDetails: { settlementSnapshot: snapshot },
  });

  const completeReq = {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { redemptionId },
    body: {},
    query: {},
    headers: {},
    ip: "127.0.0.1",
  };
  await transitionRedemption(completeReq, "complete");

  const completed = await Redemption.findById(redemptionId).lean();
  assert.equal(completed.calculatedBenefitPaise, BONUS_PAISE);
  assert.equal(completed.includedBenefitPaise, 0);
  assert.equal(completed.benefitPaise, 0);
  assert.equal(completed.cashOutPaise, PRINCIPAL_PAISE);
  assert.equal(completed.settlementPaise, PRINCIPAL_PAISE);

  assert.equal(
    await LedgerEntry.countDocuments({
      schemeId: scheme._id,
      type: LedgerEntryType.BENEFIT_CREDIT,
    }),
    0,
  );
  const debit = await LedgerEntry.findOne({
    schemeId: scheme._id,
    type: LedgerEntryType.REDEMPTION_DEBIT,
  }).lean();
  assert.equal(debit.amountPaise, PRINCIPAL_PAISE);
  assert.equal(debit.weightMg, WEIGHT_MG);
});
