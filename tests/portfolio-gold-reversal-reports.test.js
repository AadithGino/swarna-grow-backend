import test from "node:test";
import assert from "node:assert/strict";
import { createId } from "../src/lib/ids.js";
import { Branch, LedgerEntry, Scheme } from "../src/models/index.js";
import {
  LedgerEntryType,
  PaymentPattern,
  SchemeStatus,
  TenantRole,
  ValueBasis,
} from "../src/constants/enums.js";
import { buildSchemeRegisterReport } from "../src/services/report-builders/scheme-register.report.js";
import { chart } from "../src/services/reporting.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

function reportReq(user, tenant, branch, query = {}) {
  return {
    auth: {
      id: user._id,
      tenantId: tenant._id,
      type: "TENANT_USER",
      role: TenantRole.TENANT_OWNER,
    },
    scope: branch ? { tenantId: tenant._id, branchId: branch._id } : { tenantId: tenant._id },
    query,
  };
}

async function seedGoldScheme({ tenant, branch, enrollmentNumber }) {
  const planId = createId("schemePlan");
  const customerId = createId("customer");
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

test("scheme register nets 200 mg accrual minus 50 mg reversal to 150 mg", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const scheme = await seedGoldScheme({ tenant, branch, enrollmentNumber: "ENR-NET-1" });
  await LedgerEntry.create([
    {
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId: scheme.customerId,
      type: LedgerEntryType.INSTALLMENT_PAYMENT,
      sequence: 1,
      weightMg: 200,
      amountPaise: 100_000,
      effectiveAt: new Date("2026-09-02T10:00:00+05:30"),
    },
    {
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId: scheme.customerId,
      type: LedgerEntryType.REVERSAL,
      sequence: 2,
      weightMg: 50,
      amountPaise: 25_000,
      effectiveAt: new Date("2026-09-03T10:00:00+05:30"),
    },
  ]);

  const result = await buildSchemeRegisterReport(
    reportReq(user, tenant, branch, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-30",
    }),
  );
  const summaryMg = result.summary.find((r) => r.key === "GRAMS")?.value.weightMg;
  assert.equal(summaryMg, 150);
  assert.equal(result.rows[0].grams.weightMg, 150);
  const rowSum = result.rows.reduce((s, r) => s + r.grams.weightMg, 0);
  assert.equal(summaryMg, rowSum);
});

test("scheme register full reversal reports zero grams not double-counted", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const scheme = await seedGoldScheme({ tenant, branch, enrollmentNumber: "ENR-NET-2" });
  await LedgerEntry.create([
    {
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId: scheme.customerId,
      type: LedgerEntryType.INSTALLMENT_PAYMENT,
      sequence: 1,
      weightMg: 200,
      amountPaise: 100_000,
      effectiveAt: new Date("2026-09-02T10:00:00+05:30"),
    },
    {
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId: scheme.customerId,
      type: LedgerEntryType.REVERSAL,
      sequence: 2,
      weightMg: 200,
      amountPaise: 100_000,
      effectiveAt: new Date("2026-09-03T10:00:00+05:30"),
    },
  ]);

  const result = await buildSchemeRegisterReport(
    reportReq(user, tenant, branch, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-30",
    }),
  );
  const summaryMg = result.summary.find((r) => r.key === "GRAMS")?.value.weightMg;
  assert.equal(summaryMg, 0);
  assert.equal(result.rows[0].grams.weightMg, 0);
});

test("gold-accrual trend cumulative drops after reversal in later period", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const scheme = await seedGoldScheme({ tenant, branch, enrollmentNumber: "ENR-TREND" });
  await LedgerEntry.create([
    {
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId: scheme.customerId,
      type: LedgerEntryType.INSTALLMENT_PAYMENT,
      sequence: 1,
      weightMg: 300,
      amountPaise: 150_000,
      effectiveAt: new Date("2026-09-02T10:00:00+05:30"),
    },
    {
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId: scheme.customerId,
      type: LedgerEntryType.REVERSAL,
      sequence: 2,
      weightMg: 100,
      amountPaise: 50_000,
      effectiveAt: new Date("2026-09-05T10:00:00+05:30"),
    },
  ]);

  const chartEnvelope = await chart(
    reportReq(user, tenant, branch, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-06",
    }),
    "gold-accrual-trend",
  );
  const trend = chartEnvelope.series[0].data;
  const byDay = new Map(trend.map((p) => [p.x, p.y]));
  assert.equal(byDay.get("2026-09-02"), 300);
  assert.equal(byDay.get("2026-09-05"), 200);
  assert.equal(byDay.get("2026-09-06"), 200);
});

test("scheme register branch scope excludes other branch ledger grams", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const otherBranch = await Branch.create({
    _id: createId("branch"),
    tenantId: tenant._id,
    name: "Other",
    code: "OTH",
    isHeadOffice: false,
    active: true,
  });
  const schemeA = await seedGoldScheme({ tenant, branch, enrollmentNumber: "ENR-BR-A" });
  const schemeB = await seedGoldScheme({
    tenant,
    branch: otherBranch,
    enrollmentNumber: "ENR-BR-B",
  });
  await LedgerEntry.create([
    {
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: schemeA._id,
      customerId: schemeA.customerId,
      type: LedgerEntryType.INSTALLMENT_PAYMENT,
      sequence: 1,
      weightMg: 100,
      amountPaise: 50_000,
      effectiveAt: new Date("2026-09-02T10:00:00+05:30"),
    },
    {
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: otherBranch._id,
      schemeId: schemeB._id,
      customerId: schemeB.customerId,
      type: LedgerEntryType.INSTALLMENT_PAYMENT,
      sequence: 1,
      weightMg: 900,
      amountPaise: 450_000,
      effectiveAt: new Date("2026-09-02T10:00:00+05:30"),
    },
  ]);

  const result = await buildSchemeRegisterReport(
    reportReq(user, tenant, branch, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-30",
    }),
  );
  assert.equal(result.summary.find((r) => r.key === "GRAMS")?.value.weightMg, 100);
});
