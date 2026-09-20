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
  LedgerEntryType,
  RedemptionMode,
  SchemeStatus,
  TenantRole,
} from "../src/constants/enums.js";
import { assertV1GoldPurity, currentGoldRate22K } from "../src/lib/gold-rate-lookup.js";
import { planBody } from "../src/validators/common.validators.js";
import {
  decimalRoundingMode,
  moneyToWeightMg,
  applyWeightPrecisionMg,
  weightMgToMoneyPaise,
} from "../src/lib/money.js";
import { setGoldRate } from "../src/services/tenant.service.js";
import {
  requestCustomerRedemption,
  settlementPreview,
  transitionRedemption,
} from "../src/services/redemption.service.js";
import { AppError } from "../src/lib/app-error.js";
import { now, today } from "../src/lib/date.js";
import { ClosureType } from "../src/constants/enums.js";
import { recordPayment } from "../src/services/payment.service.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function seedCashMaturedWithGoldHandover({ settlementPaise = 300000 } = {}) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-GH-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      valueBasis: "CASH",
      redemptionRules: {
        allowedModes: [RedemptionMode.CASH, RedemptionMode.GOLD_HANDOVER],
        prematureClosureAllowed: false,
      },
      benefit: { type: "TEXT_ONLY", displayLabel: "Gift" },
    },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: SchemeStatus.MATURED,
    startDate: "2025-01-01",
    maturityDate: "2025-12-01",
    installmentAmountPaise: settlementPaise / 3,
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
    amountPaise: settlementPaise,
    actorType: "USER",
    actorId: user._id,
    description: "Paid",
  });
  await Scheme.updateOne({ _id: scheme._id }, { $set: { ledgerNextSequence: 1 } });
  return { tenant, branch, user, customer, scheme, settlementPaise };
}

test("setGoldRate rejects non-22K purity", async () => {
  const { tenant, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await assert.rejects(
    () => setGoldRate({
      auth: { id: user._id, tenantId: tenant._id },
      body: {
        effectiveDate: "2026-03-01",
        ratePerGramPaise: 600000,
        purity: "24K",
      },
    }),
    (error) => error instanceof AppError && error.code === "GOLD_PURITY_NOT_SUPPORTED",
  );
});

test("operational rate lookup ignores non-22K historical rows", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await GoldRate.create({
    _id: createId("grt"),
    tenantId: tenant._id,
    branchId: branch._id,
    effectiveDate: today(),
    ratePerGramPaise: 999999,
    purity: "24K",
    enteredBy: user._id,
  });
  await setGoldRate({
    auth: { id: user._id, tenantId: tenant._id },
    headers: { "user-agent": "test" },
    body: { effectiveDate: today(), ratePerGramPaise: 550000 },
  });
  const rate = await currentGoldRate22K({ tenantId: tenant._id, branchId: branch._id }, today());
  assert.equal(rate.ratePerGramPaise, 550000);
  assert.equal(rate.purity, "22K");
});

test("cash-plan gold handover uses exact handover-day 22K rate and weight", async () => {
  const { tenant, branch, user, customer, scheme, settlementPaise } =
    await seedCashMaturedWithGoldHandover();
  const handoverDay = today();
  await setGoldRate({
    auth: { id: user._id, tenantId: tenant._id },
    headers: { "user-agent": "test" },
    body: { effectiveDate: handoverDay, ratePerGramPaise: 500000, branchId: branch._id },
  });
  await GoldRate.create({
    _id: createId("grt"),
    tenantId: tenant._id,
    branchId: branch._id,
    effectiveDate: "2020-01-01",
    ratePerGramPaise: 100000,
    purity: "22K",
    enteredBy: user._id,
  });
  const requested = await requestCustomerRedemption({
    auth: { id: customer._id, tenantId: tenant._id, type: "CUSTOMER" },
    scope: { tenantId: tenant._id },
    params: { schemeId: scheme._id },
    body: { preferredMode: RedemptionMode.GOLD_HANDOVER, expectedVersion: scheme.version },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  });
  await transitionRedemption({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { redemptionId: requested.id },
    body: {},
    query: {},
    headers: {},
    ip: "127.0.0.1",
  }, "approve");
  await transitionRedemption({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { redemptionId: requested.id },
    body: {},
    query: {},
    headers: {},
    ip: "127.0.0.1",
  }, "complete");
  const completed = await Redemption.findById(requested.id).lean();
  assert.equal(completed.handoverRateEffectiveDate, handoverDay);
  assert.equal(completed.handoverRatePerGramPaise, 500000);
  assert.equal(completed.cashOutPaise, 0);
  assert.ok(completed.weightMg > 0);
  const debit = await LedgerEntry.findOne({
    schemeId: scheme._id,
    type: LedgerEntryType.REDEMPTION_DEBIT,
  }).lean();
  assert.equal(debit.amountPaise, settlementPaise);
  assert.equal(debit.weightMg, completed.weightMg);
});

test("gold handover blocked when exact-day rate missing", async () => {
  const { branch, user, customer, scheme } = await seedCashMaturedWithGoldHandover();
  const requested = await requestCustomerRedemption({
    auth: { id: customer._id, tenantId: scheme.tenantId, type: "CUSTOMER" },
    scope: { tenantId: scheme.tenantId },
    params: { schemeId: scheme._id },
    body: { preferredMode: RedemptionMode.GOLD_HANDOVER, expectedVersion: scheme.version },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  });
  await transitionRedemption({
    auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
    scope: { tenantId: scheme.tenantId, branchId: branch._id },
    params: { redemptionId: requested.id },
    body: {},
    query: {},
    headers: {},
    ip: "127.0.0.1",
  }, "approve");
  await assert.rejects(
    () => transitionRedemption({
      auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
      scope: { tenantId: scheme.tenantId, branchId: branch._id },
      params: { redemptionId: requested.id },
      body: {},
      query: {},
      headers: {},
      ip: "127.0.0.1",
    }, "complete"),
    (error) => error.code === "GOLD_RATE_NOT_SET",
  );
});

test("gold benefit rounding modes match plan rules", () => {
  const benefitPaise = 500000;
  const rate = 500000;
  const modes = [
    ["ROUND_DOWN", 100],
    ["ROUND_UP", 100],
    ["HALF_UP", 1000],
  ];
  for (const [mode, precision] of modes) {
    const rounding = decimalRoundingMode(mode);
    let mg = moneyToWeightMg(benefitPaise, rate, rounding);
    mg = applyWeightPrecisionMg(mg, precision, rounding);
    assert.ok(mg > 0);
  }
});

test("gold benefit conversion precision matrix", () => {
  const rate = 500_000;
  const cases = [
    { benefitPaise: 123_456, mode: "ROUND_DOWN", precision: 100, expectedMg: 200 },
    { benefitPaise: 123_456, mode: "ROUND_UP", precision: 100, expectedMg: 300 },
    { benefitPaise: 250_000, mode: "HALF_UP", precision: 1, expectedMg: 500 },
    { benefitPaise: 250_001, mode: "HALF_UP", precision: 10, expectedMg: 500 },
  ];
  for (const row of cases) {
    const rounding = decimalRoundingMode(row.mode);
    let mg = moneyToWeightMg(row.benefitPaise, rate, rounding);
    mg = applyWeightPrecisionMg(mg, row.precision, rounding);
    assert.equal(mg, row.expectedMg, `${row.mode}/${row.precision}`);
  }
});

async function seedGoldWeightMaturedHandover({ weightMg = 600, amountPaise = 300_000 } = {}) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-GWM-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      valueBasis: "GOLD_WEIGHT",
      goldRules: {
        weightRoundingMode: "HALF_UP",
        weightPrecisionMg: 1,
      },
      redemptionRules: {
        allowedModes: [RedemptionMode.GOLD_HANDOVER],
        prematureClosureAllowed: false,
      },
      benefit: { type: "TEXT_ONLY", displayLabel: "Gift" },
    },
    valueBasis: "GOLD_WEIGHT",
    paymentPattern: "FIXED",
    status: SchemeStatus.MATURED,
    startDate: "2024-01-01",
    maturityDate: "2025-12-01",
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
    weightMg,
    actorType: "USER",
    actorId: user._id,
    description: "Gold paid",
  });
  await Scheme.updateOne({ _id: scheme._id }, { $set: { ledgerNextSequence: 1 } });
  return { tenant, branch, user, customer, scheme, weightMg, amountPaise };
}

test("gold-weight plan handover uses exact handover-day rate for valuation", async () => {
  const { tenant, branch, user, customer, scheme, weightMg } =
    await seedGoldWeightMaturedHandover();
  const handoverDay = today();
  const yesterday = now().subtract(1, "day").format("YYYY-MM-DD");
  await GoldRate.create({
    _id: createId("grt"),
    tenantId: tenant._id,
    branchId: branch._id,
    effectiveDate: yesterday,
    ratePerGramPaise: 400_000,
    purity: "22K",
    enteredBy: user._id,
  });
  await setGoldRate({
    auth: { id: user._id, tenantId: tenant._id },
    headers: { "user-agent": "test" },
    body: { effectiveDate: handoverDay, ratePerGramPaise: 520_000, branchId: branch._id },
  });
  const requested = await requestCustomerRedemption({
    auth: { id: customer._id, tenantId: tenant._id, type: "CUSTOMER" },
    scope: { tenantId: tenant._id },
    params: { schemeId: scheme._id },
    body: { preferredMode: RedemptionMode.GOLD_HANDOVER, expectedVersion: scheme.version },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  });
  await transitionRedemption({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { redemptionId: requested.id },
    body: {},
    query: {},
    headers: {},
    ip: "127.0.0.1",
  }, "approve");
  await transitionRedemption({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { redemptionId: requested.id },
    body: {},
    query: {},
    headers: {},
    ip: "127.0.0.1",
  }, "complete");
  const completed = await Redemption.findById(requested.id).lean();
  assert.equal(completed.handoverRateEffectiveDate, handoverDay);
  assert.equal(completed.handoverRatePerGramPaise, 520_000);
  const expectedValue = weightMgToMoneyPaise(weightMg, 520_000, decimalRoundingMode("HALF_UP"));
  assert.equal(completed.handoverValuePaise, expectedValue);
  assert.notEqual(completed.handoverValuePaise, weightMgToMoneyPaise(weightMg, 400_000));
});

test("assertV1GoldPurity accepts 22K only", () => {
  assert.doesNotThrow(() => assertV1GoldPurity("22K"));
  assert.throws(() => assertV1GoldPurity("18K"));
});

test("yesterday 22K rate does not satisfy exact handover-day requirement", async () => {
  const { branch, user, customer, scheme } = await seedCashMaturedWithGoldHandover();
  const yesterday = now().subtract(1, "day").format("YYYY-MM-DD");
  await GoldRate.create({
    _id: createId("grt"),
    tenantId: scheme.tenantId,
    branchId: branch._id,
    effectiveDate: yesterday,
    ratePerGramPaise: 500000,
    purity: "22K",
    enteredBy: user._id,
  });
  const requested = await requestCustomerRedemption({
    auth: { id: customer._id, tenantId: scheme.tenantId, type: "CUSTOMER" },
    scope: { tenantId: scheme.tenantId },
    params: { schemeId: scheme._id },
    body: { preferredMode: RedemptionMode.GOLD_HANDOVER, expectedVersion: scheme.version },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  });
  await transitionRedemption({
    auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
    scope: { tenantId: scheme.tenantId, branchId: branch._id },
    params: { redemptionId: requested.id },
    body: {},
    query: {},
    headers: {},
    ip: "127.0.0.1",
  }, "approve");
  await assert.rejects(
    () => transitionRedemption({
      auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
      scope: { tenantId: scheme.tenantId, branchId: branch._id },
      params: { redemptionId: requested.id },
      body: {},
      query: {},
      headers: {},
      ip: "127.0.0.1",
    }, "complete"),
    (error) => error.code === "GOLD_RATE_NOT_SET",
  );
});

async function seedPrematureScheme({ benefitTreatment }) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const paid = 300000;
  const bonus = 50000;
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-PR-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      redemptionRules: {
        allowedModes: [RedemptionMode.CASH],
        prematureClosureAllowed: true,
        lockInMonths: 0,
        prematurePenalty: { mode: "NONE", value: 0, benefitTreatment },
      },
      benefit: { type: "FIXED_BONUS_AMOUNT", bonusValue: bonus },
    },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: SchemeStatus.ACTIVE,
    startDate: "2020-01-01",
    maturityDate: "2030-12-01",
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
  await Scheme.updateOne({ _id: scheme._id }, { $set: { ledgerNextSequence: 1 } });
  const previewReq = {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { schemeId: scheme._id },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  };
  return { scheme, previewReq, paid, bonus };
}

test("premature FULL settlement preview includes configured benefit", async () => {
  const { previewReq, paid, bonus } = await seedPrematureScheme({ benefitTreatment: "FULL" });
  const preview = await settlementPreview(previewReq, ClosureType.PREMATURE_CLOSURE);
  assert.equal(preview.benefitPaise, bonus);
  assert.equal(preview.settlementPaise, paid + bonus);
});

test("premature FORFEIT settlement preview excludes benefit", async () => {
  const { previewReq, paid, bonus } = await seedPrematureScheme({ benefitTreatment: "FORFEIT" });
  const preview = await settlementPreview(previewReq, ClosureType.PREMATURE_CLOSURE);
  assert.equal(preview.benefitPaise, 0);
  assert.equal(preview.settlementPaise, paid);
  assert.notEqual(bonus, 0);
});

test("transfer-to-scheme mode rejected for new redemptions", async () => {
  const { customer, scheme } = await seedCashMaturedWithGoldHandover();
  await assert.rejects(
    () => requestCustomerRedemption({
      auth: { id: customer._id, tenantId: scheme.tenantId, type: "CUSTOMER" },
      scope: { tenantId: scheme.tenantId },
      params: { schemeId: scheme._id },
      body: {
        preferredMode: RedemptionMode.TRANSFER_TO_SCHEME,
        expectedVersion: scheme.version,
      },
      query: {},
      headers: {},
      ip: "127.0.0.1",
    }),
    (error) => error.code === "REDEMPTION_MODE_NOT_SUPPORTED",
  );
});

test("purchase adjustment requires bill number", async () => {
  const { customer, scheme } = await seedCashMaturedWithGoldHandover({
    settlementPaise: 300000,
  });
  await Scheme.updateOne(
    { _id: scheme._id },
    {
      $set: {
        "planSnapshot.redemptionRules.allowedModes": [
          RedemptionMode.CASH,
          RedemptionMode.PURCHASE_ADJUSTMENT,
        ],
      },
    },
  );
  const refreshed = await Scheme.findById(scheme._id).lean();
  await assert.rejects(
    () => requestCustomerRedemption({
      auth: { id: customer._id, tenantId: scheme.tenantId, type: "CUSTOMER" },
      scope: { tenantId: scheme.tenantId },
      params: { schemeId: refreshed._id },
      body: {
        preferredMode: RedemptionMode.PURCHASE_ADJUSTMENT,
        expectedVersion: refreshed.version,
        modeDetails: {},
      },
      query: {},
      headers: {},
      ip: "127.0.0.1",
    }),
    (error) => error.code === "BILL_NUMBER_REQUIRED",
  );
});

test("plan validation rejects PRORATE premature benefit treatment", () => {
  const parsed = planBody.safeParse({
    name: "Fixed plan",
    code: "FXPRORATE",
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    durationMonths: 12,
    installmentCount: 12,
    amountRules: { amountMode: "FIXED", fixedAmountPaise: 100000 },
    scheduleRules: {
      dueDateRule: "FIXED_DAY_OF_MONTH",
      dueDayOfMonth: 5,
      firstInstallmentModeDefault: "START_NEXT_CYCLE",
    },
    paymentRules: { partialPaymentAllowed: false, minPaymentPaise: 100000 },
    redemptionRules: {
      prematureClosureAllowed: true,
      lockInMonths: 0,
      prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "PRORATE" },
      allowedModes: [RedemptionMode.CASH],
      redeemAtAnyBranch: false,
    },
    availability: {
      allBranches: true,
      branchIds: [],
      visibleInCustomerApp: true,
      customerSelfEnrolAllowed: true,
    },
  });
  assert.equal(parsed.success, false);
  assert.ok(
    parsed.error?.issues.some(
      (issue) => issue.path.join(".") === "redemptionRules.prematurePenalty.benefitTreatment",
    ),
  );
});

test("purchase adjustment completion has zero cash out and bill on ledger", async () => {
  const billNumber = "BILL-PH4-001";
  const { tenant, branch, user, customer, scheme, settlementPaise } =
    await seedCashMaturedWithGoldHandover();
  await Scheme.updateOne(
    { _id: scheme._id },
    {
      $set: {
        "planSnapshot.redemptionRules.allowedModes": [
          RedemptionMode.CASH,
          RedemptionMode.PURCHASE_ADJUSTMENT,
        ],
      },
    },
  );
  const refreshed = await Scheme.findById(scheme._id).lean();
  const requested = await requestCustomerRedemption({
    auth: { id: customer._id, tenantId: tenant._id, type: "CUSTOMER" },
    scope: { tenantId: tenant._id },
    params: { schemeId: refreshed._id },
    body: {
      preferredMode: RedemptionMode.PURCHASE_ADJUSTMENT,
      expectedVersion: refreshed.version,
      modeDetails: { billNumber },
    },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  });
  await transitionRedemption({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { redemptionId: requested.id },
    body: {},
    query: {},
    headers: {},
    ip: "127.0.0.1",
  }, "approve");
  await transitionRedemption({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { redemptionId: requested.id },
    body: { modeDetails: { billNumber } },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  }, "complete");
  const completed = await Redemption.findById(requested.id).lean();
  assert.equal(completed.cashOutPaise, 0);
  assert.equal(completed.handoverValuePaise, 0);
  assert.equal(completed.modeDetails?.billNumber, billNumber);
  const debit = await LedgerEntry.findOne({
    schemeId: scheme._id,
    type: LedgerEntryType.REDEMPTION_DEBIT,
  }).lean();
  assert.equal(debit.amountPaise, settlementPaise);
  assert.equal(debit.description, "Purchase adjustment completed");
  assert.equal(debit.metadata?.billNumber, billNumber);
});

test("legacy transfer redemption record remains readable", async () => {
  const { tenant, branch, user, customer, scheme } = await seedCashMaturedWithGoldHandover();
  const legacyId = createId("redemption");
  await Redemption.create({
    _id: legacyId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    closureType: ClosureType.MATURITY_REDEMPTION,
    mode: RedemptionMode.TRANSFER_TO_SCHEME,
    status: "COMPLETED",
    settlementPaise: 100000,
    cashOutPaise: 0,
    requestedBy: user._id,
    requestedAt: now(),
    completedAt: now(),
  });
  const row = await Redemption.findById(legacyId).lean();
  assert.equal(row.mode, RedemptionMode.TRANSFER_TO_SCHEME);
  assert.equal(row.status, "COMPLETED");
});

test("gold-weight payment rejected when amount rounds to zero weight", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await setGoldRate({
    auth: { id: user._id, tenantId: tenant._id },
    headers: { "user-agent": "test" },
    body: { effectiveDate: today(), ratePerGramPaise: 600000, branchId: branch._id },
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-GWZ-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      goldRules: {
        weightRoundingMode: "HALF_UP",
        weightPrecisionMg: 1,
      },
      paymentRules: { partialPaymentAllowed: true, minPaymentPaise: 1 },
    },
    valueBasis: "GOLD_WEIGHT",
    paymentPattern: "FIXED",
    status: SchemeStatus.ACTIVE,
    startDate: today(),
    maturityDate: "2030-12-01",
    installmentAmountPaise: 100000,
    installments: [{
      number: 1,
      dueDate: today(),
      amountPaise: 100000,
      paidPaise: 0,
      status: "DUE",
      graceEndsAt: today(),
    }],
    positionVersion: 0,
    version: 1,
    createdBy: user._id,
  });
  await assert.rejects(
    () => recordPayment({
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
      scope: { tenantId: tenant._id, branchId: branch._id },
      baseUrl: "/api/v1/admin",
      headers: { "user-agent": "test" },
      ip: "127.0.0.1",
      body: { schemeId: scheme._id, amountPaise: 1, mode: "CASH", expectedVersion: 0 },
      query: {},
    }),
    (error) => error.code === "GOLD_WEIGHT_ROUNDS_TO_ZERO",
  );
});

test("gold-weight payment rejected when today 22K rate is missing", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-GW-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      goldRules: {
        weightRoundingMode: "HALF_UP",
        weightPrecisionMg: 1,
        blockPaymentIfRateNotSet: false,
      },
      paymentRules: { partialPaymentAllowed: true, minPaymentPaise: 1000 },
    },
    valueBasis: "GOLD_WEIGHT",
    paymentPattern: "FIXED",
    status: SchemeStatus.ACTIVE,
    startDate: today(),
    maturityDate: "2030-12-01",
    installmentAmountPaise: 100000,
    installments: [{
      number: 1,
      dueDate: today(),
      amountPaise: 100000,
      paidPaise: 0,
      status: "DUE",
      graceEndsAt: today(),
    }],
    positionVersion: 0,
    version: 1,
    createdBy: user._id,
  });
  await assert.rejects(
    () => recordPayment({
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
      scope: { tenantId: tenant._id, branchId: branch._id },
      baseUrl: "/api/v1/admin",
      headers: { "user-agent": "test" },
      ip: "127.0.0.1",
      body: { schemeId: scheme._id, amountPaise: 100000, mode: "CASH", expectedVersion: 0 },
      query: {},
    }),
    (error) => error.code === "GOLD_RATE_NOT_SET",
  );
});
