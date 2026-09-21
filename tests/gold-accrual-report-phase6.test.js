import test from "node:test";
import assert from "node:assert/strict";
import { createId } from "../src/lib/ids.js";
import { GoldRate, LedgerEntry, Scheme } from "../src/models/index.js";
import {
  LedgerEntryType,
  PaymentPattern,
  SchemeStatus,
  TenantRole,
  ValueBasis,
} from "../src/constants/enums.js";
import { buildGoldAccrualReport } from "../src/services/report-builders/gold-accrual.report.js";
import {
  goldAccrualLiabilityPaise,
  weightedAccrualRatePerGramPaise,
} from "../src/lib/gold-accrual-netting.js";
import { moneyPaiseFromWeightMg } from "../src/lib/money.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { today } from "../src/lib/date.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function reportReq(user, tenant, branch, query = {}) {
  return {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER", role: TenantRole.TENANT_OWNER },
    scope: { tenantId: tenant._id, branchId: branch._id },
    query,
  };
}

async function seedGoldScheme({ tenant, branch, planId, customerId, enrollmentNumber }) {
  return Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    planId,
    enrollmentNumber,
    planSnapshot: { name: "Gold plan" },
    valueBasis: ValueBasis.GOLD_WEIGHT,
    paymentPattern: PaymentPattern.FIXED,
    status: SchemeStatus.ACTIVE,
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installmentAmountPaise: 100_000,
    installments: [],
  });
}

async function seedRate(tenant, branch) {
  await GoldRate.create({
    _id: createId("goldRate"),
    tenantId: tenant._id,
    branchId: branch._id,
    purity: "22K",
    effectiveDate: today(),
    ratePerGramPaise: 500_000,
    source: "MANUAL",
  });
}

test("500 mg payment + full reversal nets zero grams and received", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await seedRate(tenant, branch);
  const planId = createId("schemePlan");
  const customerId = createId("customer");
  const scheme = await seedGoldScheme({
    tenant,
    branch,
    planId,
    customerId,
    enrollmentNumber: "ENR-REV-1",
  });
  await LedgerEntry.create([
    {
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId,
      type: LedgerEntryType.INSTALLMENT_PAYMENT,
      sequence: 1,
      weightMg: 500,
      amountPaise: 250_000,
      ratePerGramPaise: 500_000,
      effectiveAt: new Date("2026-09-02T10:00:00+05:30"),
    },
    {
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId,
      type: LedgerEntryType.REVERSAL,
      sequence: 2,
      weightMg: 500,
      amountPaise: 250_000,
      effectiveAt: new Date("2026-09-03T10:00:00+05:30"),
    },
  ]);

  const result = await buildGoldAccrualReport(
    reportReq(user, tenant, branch, { period: "CUSTOM", from: "2026-09-01", to: "2026-09-05" }),
  );
  const grams = result.summary.find((r) => r.key === "TOTAL_GRAMS")?.value.weightMg;
  const received = result.summary.find((r) => r.key === "AMOUNT_RECEIVED")?.value.amountPaise;
  assert.equal(grams, 0);
  assert.equal(received, 0);
  assert.equal(result.rows[0].gramsAccrued.weightMg, 0);
});

test("two payments produce weighted average rate not arithmetic mean", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await seedRate(tenant, branch);
  const planId = createId("schemePlan");
  const customerId = createId("customer");
  const scheme = await seedGoldScheme({
    tenant,
    branch,
    planId,
    customerId,
    enrollmentNumber: "ENR-WGT-1",
  });
  await LedgerEntry.create([
    {
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId,
      type: LedgerEntryType.INSTALLMENT_PAYMENT,
      sequence: 1,
      weightMg: 1000,
      amountPaise: 400_000,
      ratePerGramPaise: 400_000,
      effectiveAt: new Date("2026-09-01T10:00:00+05:30"),
    },
    {
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId,
      type: LedgerEntryType.INSTALLMENT_PAYMENT,
      sequence: 2,
      weightMg: 500,
      amountPaise: 300_000,
      ratePerGramPaise: 600_000,
      effectiveAt: new Date("2026-09-02T10:00:00+05:30"),
    },
  ]);
  const expectedRate = weightedAccrualRatePerGramPaise(700_000, 1500);
  assert.equal(expectedRate, 466_667);

  const result = await buildGoldAccrualReport(
    reportReq(user, tenant, branch, { period: "CUSTOM", from: "2026-09-01", to: "2026-09-03" }),
  );
  assert.equal(result.rows[0].averageRatePaid.ratePerGramPaise, expectedRate);
  assert.equal(result.rows[0].gramsAccrued.weightMg, 1500);
});

test("reversal in later period reduces cumulative trend on reversal date", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await seedRate(tenant, branch);
  const customerId = createId("customer");
  const scheme = await seedGoldScheme({
    tenant,
    branch,
    planId: createId("schemePlan"),
    customerId,
    enrollmentNumber: "ENR-TR-1",
  });
  await LedgerEntry.create([
    {
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId,
      type: LedgerEntryType.INSTALLMENT_PAYMENT,
      sequence: 1,
      weightMg: 800,
      amountPaise: 400_000,
      effectiveAt: new Date("2026-09-01T10:00:00+05:30"),
    },
    {
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId,
      type: LedgerEntryType.REVERSAL,
      sequence: 2,
      weightMg: 300,
      amountPaise: 150_000,
      effectiveAt: new Date("2026-09-03T10:00:00+05:30"),
    },
  ]);

  const result = await buildGoldAccrualReport(
    reportReq(user, tenant, branch, { period: "CUSTOM", from: "2026-09-01", to: "2026-09-03" }),
  );
  const trend = result.charts.accrualTrend.series[0].data;
  assert.equal(trend[0].y, 800);
  assert.equal(trend[1].y, 800);
  assert.equal(trend[2].y, 500);
});

test("unallocated payment excluded from gold accrual", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await seedRate(tenant, branch);
  const customerId = createId("customer");
  const scheme = await seedGoldScheme({
    tenant,
    branch,
    planId: createId("schemePlan"),
    customerId,
    enrollmentNumber: "ENR-UNA-1",
  });
  await LedgerEntry.create([
    {
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId,
      type: LedgerEntryType.INSTALLMENT_PAYMENT,
      sequence: 1,
      weightMg: 200,
      amountPaise: 100_000,
      effectiveAt: new Date("2026-09-01T10:00:00+05:30"),
    },
    {
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId,
      type: LedgerEntryType.UNALLOCATED_PAYMENT,
      sequence: 2,
      weightMg: 900,
      amountPaise: 450_000,
      effectiveAt: new Date("2026-09-02T10:00:00+05:30"),
    },
  ]);

  const result = await buildGoldAccrualReport(
    reportReq(user, tenant, branch, { period: "CUSTOM", from: "2026-09-01", to: "2026-09-03" }),
  );
  assert.equal(result.summary.find((r) => r.key === "TOTAL_GRAMS")?.value.weightMg, 200);
});

test("multiple plans isolated and summary matches unpaginated plan totals", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await seedRate(tenant, branch);
  const planA = createId("schemePlan");
  const planB = createId("schemePlan");
  const customerId = createId("customer");
  const schemeA = await seedGoldScheme({
    tenant,
    branch,
    planId: planA,
    customerId,
    enrollmentNumber: "ENR-A",
  });
  await Scheme.updateOne({ _id: schemeA._id }, { $set: { "planSnapshot.name": "Plan A" } });
  const schemeB = await seedGoldScheme({
    tenant,
    branch,
    planId: planB,
    customerId,
    enrollmentNumber: "ENR-B",
  });
  await Scheme.updateOne({ _id: schemeB._id }, { $set: { "planSnapshot.name": "Plan B" } });
  await LedgerEntry.create([
    {
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: schemeA._id,
      customerId,
      type: LedgerEntryType.INSTALLMENT_PAYMENT,
      sequence: 1,
      weightMg: 400,
      amountPaise: 200_000,
      effectiveAt: new Date("2026-09-01T10:00:00+05:30"),
    },
    {
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: schemeB._id,
      customerId,
      type: LedgerEntryType.INSTALLMENT_PAYMENT,
      sequence: 1,
      weightMg: 600,
      amountPaise: 300_000,
      effectiveAt: new Date("2026-09-01T10:00:00+05:30"),
    },
  ]);

  const result = await buildGoldAccrualReport(
    reportReq(user, tenant, branch, { period: "CUSTOM", from: "2026-09-01", to: "2026-09-03", limit: 1 }),
  );
  assert.equal(result.meta.total, 2);
  const rowSumMg = result.rows.reduce((s, r) => s + r.gramsAccrued.weightMg, 0);
  assert.ok(rowSumMg < 1000);
  const totalMg = result.summary.find((r) => r.key === "TOTAL_GRAMS")?.value.weightMg;
  assert.equal(totalMg, 1000);
  const liability = result.summary.find((r) => r.key === "LIABILITY_TODAY")?.value.amountPaise;
  assert.equal(liability, goldAccrualLiabilityPaise(1000, 500_000));
  assert.equal(liability, moneyPaiseFromWeightMg(1000, 500_000));
});
