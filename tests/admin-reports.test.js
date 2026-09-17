import test from "node:test";
import assert from "node:assert/strict";
import "../src/lib/date.js";
import {
  Branch,
  Customer,
  LedgerEntry,
  Message,
  Payment,
  Redemption,
  Scheme,
  SchemePlan,
  User,
} from "../src/models/index.js";
import {
  MessageChannel,
  MessageStatus,
  MessageType,
  PaymentSource,
  PaymentStatus,
  UserStatus,
  UserType,
} from "../src/constants/enums.js";
import { buildAdminReport } from "../src/services/report-builders/index.js";
import { buildCashHandoverReport } from "../src/services/report-builders/cash-handover.report.js";
import { buildCollectionReport } from "../src/services/report-builders/collection.report.js";
import { buildCustomerPerformanceReport } from "../src/services/report-builders/customer-performance.report.js";
import { createId } from "../src/lib/ids.js";
import { buildDefaulterReport } from "../src/services/report-builders/defaulter.report.js";
import { buildEnrolmentReport } from "../src/services/report-builders/enrolment.report.js";
import { buildGoldAccrualReport } from "../src/services/report-builders/gold-accrual.report.js";
import { buildBranchPerformanceReport } from "../src/services/report-builders/branch-performance.report.js";
import { buildMaturityRedemptionReport } from "../src/services/report-builders/maturity-redemption.report.js";
import { buildOutstandingReport } from "../src/services/report-builders/outstanding.report.js";
import { buildReminderDeliveryReport } from "../src/services/report-builders/reminder-delivery.report.js";
import { buildSchemePerformanceReport } from "../src/services/report-builders/scheme-performance.report.js";
import { buildSchemeRegisterReport } from "../src/services/report-builders/scheme-register.report.js";
import { buildStaffPerformanceReport } from "../src/services/report-builders/staff-performance.report.js";
import { buildWhatsappUsageReport } from "../src/services/report-builders/whatsapp-usage.report.js";
import {
  ClosureType,
  LedgerEntryType,
  PaymentPattern,
  RedemptionMode,
  RedemptionStatus,
  SchemeStatus,
  TenantRole,
  ValueBasis,
} from "../src/constants/enums.js";
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

function reportReq(user, tenant, query = {}) {
  return {
    auth: {
      id: user._id,
      tenantId: tenant._id,
      type: "TENANT_USER",
      role: TenantRole.TENANT_OWNER,
    },
    scope: { tenantId: tenant._id },
    query,
  };
}

test("enrolment report counts by createdAt and zero-fills trend", async () => {
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
  });
  await Scheme.create([
    {
      _id: createId("scheme"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: createId("customer"),
      planId: createId("schemePlan"),
      enrollmentNumber: "ENR-RPT-1",
      planSnapshot: { name: "Gold 11", installmentCount: 11 },
      valueBasis: "CASH",
      paymentPattern: PaymentPattern.FIXED,
      status: SchemeStatus.ACTIVE,
      startDate: "2026-08-01",
      maturityDate: "2026-07-01",
      installmentAmountPaise: 100_000,
      installments: [
        {
          number: 1,
          dueDate: "2026-08-01",
          amountPaise: 100_000,
          paidPaise: 0,
          status: "DUE",
        },
      ],
      createdAt: new Date("2026-08-20T10:00:00+05:30"),
    },
    {
      _id: createId("scheme"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: createId("customer"),
      planId: createId("schemePlan"),
      enrollmentNumber: "ENR-RPT-2",
      planSnapshot: { name: "Gold 11", installmentCount: 11 },
      valueBasis: "CASH",
      paymentPattern: PaymentPattern.FIXED,
      status: SchemeStatus.ACTIVE,
      startDate: "2026-09-01",
      maturityDate: "2026-08-01",
      installmentAmountPaise: 100_000,
      installments: [
        {
          number: 1,
          dueDate: "2026-09-01",
          amountPaise: 100_000,
          paidPaise: 0,
          status: "DUE",
        },
      ],
      createdAt: new Date("2026-09-02T10:00:00+05:30"),
    },
  ]);

  const result = await buildEnrolmentReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-03",
    }),
  );

  const newEnrolments = result.summary.find((row) => row.key === "NEW_ENROLMENTS");
  assert.equal(newEnrolments?.value, 1);
  assert.equal(result.charts.enrolmentTrend.chartType, "line");
  const trend = result.charts.enrolmentTrend.series[0].data;
  assert.equal(trend.length, 3);
  assert.equal(trend[0].y, 0);
  assert.equal(trend[1].y, 1);
  assert.equal(trend[2].y, 0);
});

test("scheme register summary reflects full portfolio, not current page", async () => {
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
  });
  const planId = createId("schemePlan");
  const schemes = Array.from({ length: 5 }, (_, index) => ({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    planId,
    enrollmentNumber: `ENR-SR-${index + 1}`,
    planSnapshot: { name: "Gold 11", installmentCount: 11 },
    valueBasis: "CASH",
    paymentPattern: PaymentPattern.FIXED,
    status: index === 0 ? SchemeStatus.MATURED : SchemeStatus.ACTIVE,
    startDate: "2026-09-01",
    maturityDate: "2026-08-01",
    installmentAmountPaise: 100_000,
    installments: [
      {
        number: 1,
        dueDate: "2026-09-01",
        amountPaise: 100_000,
        paidPaise: 0,
        status: "DUE",
      },
    ],
    createdAt: new Date(`2026-09-0${index + 1}T10:00:00+05:30`),
  }));
  await Scheme.create(schemes);

  const result = await buildSchemeRegisterReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-30",
      limit: 2,
    }),
  );

  assert.equal(result.rows.length, 2);
  assert.equal(result.meta.total, 5);
  const activeSummary = result.summary.find((row) => row.key === "ACTIVE");
  assert.equal(activeSummary?.value, 4);
  assert.equal(result.charts.statusDistribution.series[0].data.length, 2);
});

test("gold accrual report zero-fills cumulative grams trend for period", async () => {
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
  });
  const schemeId = createId("scheme");
  const planId = createId("schemePlan");
  const customerId = createId("customer");
  await Scheme.create({
    _id: schemeId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    planId,
    enrollmentNumber: "ENR-GLD-1",
    planSnapshot: { name: "Gold Accumulation", installmentCount: 11 },
    valueBasis: ValueBasis.GOLD_WEIGHT,
    paymentPattern: PaymentPattern.FIXED,
    status: SchemeStatus.ACTIVE,
    startDate: "2026-09-01",
    maturityDate: "2026-08-01",
    installmentAmountPaise: 100_000,
    installments: [
      {
        number: 1,
        dueDate: "2026-09-01",
        amountPaise: 100_000,
        paidPaise: 100_000,
        status: "PAID",
      },
    ],
  });
  await LedgerEntry.create([
    {
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId,
      customerId,
      type: LedgerEntryType.INSTALLMENT_PAYMENT,
      sequence: 1,
      weightMg: 500,
      amountPaise: 100_000,
      effectiveAt: new Date("2026-08-28T10:00:00+05:30"),
    },
    {
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId,
      customerId,
      type: LedgerEntryType.INSTALLMENT_PAYMENT,
      sequence: 2,
      weightMg: 300,
      amountPaise: 60_000,
      effectiveAt: new Date("2026-09-02T10:00:00+05:30"),
    },
  ]);

  const result = await buildGoldAccrualReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-03",
    }),
  );

  const trend = result.charts.accrualTrend.series[0].data;
  assert.equal(trend.length, 3);
  assert.equal(trend[0].y, 500);
  assert.equal(trend[1].y, 800);
  assert.equal(trend[2].y, 800);
  assert.equal(result.charts.accrualTrend.chartType, "line");
});

test("maturity redemption report zero-fills settlement trend for period", async () => {
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
  });
  const schemeId = createId("scheme");
  const customerId = createId("customer");
  await Scheme.create({
    _id: schemeId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    planId: createId("schemePlan"),
    enrollmentNumber: "ENR-RED-1",
    planSnapshot: { name: "Gold 11", installmentCount: 11 },
    valueBasis: ValueBasis.CASH,
    paymentPattern: PaymentPattern.FIXED,
    status: SchemeStatus.MATURED,
    startDate: "2026-01-01",
    maturityDate: "2026-09-01",
    installmentAmountPaise: 100_000,
    installments: [],
  });
  await Redemption.create([
    {
      _id: createId("red"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId,
      customerId,
      closureType: ClosureType.MATURITY_REDEMPTION,
      mode: RedemptionMode.CASH,
      status: RedemptionStatus.COMPLETED,
      settlementPaise: 500_000,
      cashOutPaise: 500_000,
      completedAt: new Date("2026-09-02T10:00:00+05:30"),
    },
    {
      _id: createId("red"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: createId("scheme"),
      customerId,
      closureType: ClosureType.PREMATURE_CLOSURE,
      mode: RedemptionMode.CASH,
      status: RedemptionStatus.COMPLETED,
      settlementPaise: 300_000,
      cashOutPaise: 300_000,
      completedAt: new Date("2026-09-04T10:00:00+05:30"),
    },
  ]);

  const result = await buildMaturityRedemptionReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
    }),
  );

  const trend = result.charts.settlementTrend.series[0].data;
  assert.equal(trend.length, 5);
  assert.equal(trend[0].y, 0);
  assert.equal(trend[1].y, 500_000);
  assert.equal(trend[2].y, 0);
  assert.equal(trend[3].y, 300_000);
  assert.equal(trend[4].y, 0);
});

test("branch performance report compares branches and supports detail view", async () => {
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
  });
  const otherBranch = await Branch.create({
    _id: createId("branch"),
    tenantId: tenant._id,
    name: "Thrissur Showroom",
    code: "TRSR",
    active: true,
  });
  const planId = createId("schemePlan");
  await SchemePlan.create({
    _id: planId,
    tenantId: tenant._id,
    name: "Gold 11",
    code: "G11",
    status: "ACTIVE",
    paymentPattern: PaymentPattern.FIXED,
    valueBasis: ValueBasis.CASH,
    durationMonths: 11,
    installmentCount: 11,
  });
  const schemeA = createId("scheme");
  const schemeB = createId("scheme");
  await Scheme.create([
    {
      _id: schemeA,
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: createId("customer"),
      planId,
      enrollmentNumber: "ENR-BP-1",
      planSnapshot: { name: "Gold 11", installmentCount: 11 },
      valueBasis: ValueBasis.CASH,
      paymentPattern: PaymentPattern.FIXED,
      status: SchemeStatus.ACTIVE,
      startDate: "2026-09-02",
      maturityDate: "2026-08-01",
      installmentAmountPaise: 100_000,
      installments: [],
      createdAt: new Date("2026-09-02T10:00:00+05:30"),
    },
    {
      _id: schemeB,
      tenantId: tenant._id,
      branchId: otherBranch._id,
      customerId: createId("customer"),
      planId,
      enrollmentNumber: "ENR-BP-2",
      planSnapshot: { name: "Gold 11", installmentCount: 11 },
      valueBasis: ValueBasis.CASH,
      paymentPattern: PaymentPattern.FIXED,
      status: SchemeStatus.ACTIVE,
      startDate: "2026-09-03",
      maturityDate: "2026-08-01",
      installmentAmountPaise: 100_000,
      installments: [],
      createdAt: new Date("2026-09-03T10:00:00+05:30"),
    },
  ]);
  await Payment.create([
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: otherBranch._id,
      schemeId: schemeB,
      customerId: createId("customer"),
      receiptNumber: "RCP-BP-KOC",
      amountPaise: 500_000,
      mode: "CASH",
      source: PaymentSource.PORTAL,
      paidAt: new Date("2026-09-04T10:00:00+05:30"),
    },
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: schemeA,
      customerId: createId("customer"),
      receiptNumber: "RCP-BP-MGR",
      amountPaise: 250_000,
      mode: "CASH",
      source: PaymentSource.PORTAL,
      paidAt: new Date("2026-09-02T10:00:00+05:30"),
    },
  ]);

  const comparison = await buildBranchPerformanceReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
    }),
  );
  assert.equal(comparison.title, "Branch performance comparison");
  assert.equal(comparison.rows.length, 2);
  assert.ok(comparison.charts.collectionByBranch);

  const detail = await buildBranchPerformanceReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
      branchId: otherBranch._id,
    }),
  );
  assert.match(detail.title, /Thrissur/);
  assert.equal(detail.summary.find((row) => row.key === "COLLECTED")?.value?.amountPaise, 500_000);
  assert.equal(detail.summary.find((row) => row.key === "ENROLMENTS")?.value, 1);
  assert.ok(detail.charts.collectionTrend);

  const primaryDetail = await buildBranchPerformanceReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
      branchId: branch._id,
    }),
  );
  assert.equal(
    primaryDetail.summary.find((row) => row.key === "COLLECTED")?.value?.amountPaise,
    250_000,
  );
  assert.equal(primaryDetail.summary.find((row) => row.key === "ENROLMENTS")?.value, 1);

  const scopedComparison = await buildBranchPerformanceReport({
    auth: {
      id: user._id,
      tenantId: tenant._id,
      type: "TENANT_USER",
      role: TenantRole.BRANCH_MANAGER,
    },
    scope: { tenantId: tenant._id, branchId: otherBranch._id },
    query: {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
      branchId: "ALL",
    },
  });
  assert.equal(scopedComparison.title, "Branch performance comparison");
  assert.equal(scopedComparison.rows.length, 1);
  assert.equal(scopedComparison.rows[0]?.key, otherBranch._id);
  assert.equal(scopedComparison.rows[0]?.collected?.amountPaise, 500_000);

  const blockedDetail = await buildBranchPerformanceReport({
    auth: {
      id: user._id,
      tenantId: tenant._id,
      type: "TENANT_USER",
      role: TenantRole.BRANCH_MANAGER,
    },
    scope: { tenantId: tenant._id, branchId: otherBranch._id },
    query: {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
      branchId: branch._id,
    },
  });
  assert.match(blockedDetail.title, /Thrissur/);
  assert.equal(
    blockedDetail.summary.find((row) => row.key === "COLLECTED")?.value?.amountPaise,
    500_000,
  );
});

test("scheme performance report compares plans and supports detail view", async () => {
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
  });
  const [planA, planB] = await SchemePlan.create([
    {
      _id: createId("schemePlan"),
      tenantId: tenant._id,
      name: "Gold 11",
      code: "G11",
      status: "ACTIVE",
      paymentPattern: PaymentPattern.FIXED,
      valueBasis: ValueBasis.CASH,
      durationMonths: 11,
      installmentCount: 11,
    },
    {
      _id: createId("schemePlan"),
      tenantId: tenant._id,
      name: "Flexi Save",
      code: "FLEX",
      status: "ACTIVE",
      paymentPattern: PaymentPattern.FIXED,
      valueBasis: ValueBasis.CASH,
      durationMonths: 11,
      installmentCount: 11,
    },
  ]);
  await Scheme.create([
    {
      _id: createId("scheme"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: createId("customer"),
      planId: planA._id,
      enrollmentNumber: "ENR-SP-1",
      planSnapshot: { name: "Gold 11", installmentCount: 11 },
      valueBasis: ValueBasis.CASH,
      paymentPattern: PaymentPattern.FIXED,
      status: SchemeStatus.ACTIVE,
      startDate: "2026-09-02",
      maturityDate: "2026-08-01",
      installmentAmountPaise: 100_000,
      installments: [],
      createdAt: new Date("2026-09-02T10:00:00+05:30"),
    },
    {
      _id: createId("scheme"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: createId("customer"),
      planId: planB._id,
      enrollmentNumber: "ENR-SP-2",
      planSnapshot: { name: "Flexi Save", installmentCount: 11 },
      valueBasis: ValueBasis.CASH,
      paymentPattern: PaymentPattern.FIXED,
      status: SchemeStatus.ACTIVE,
      startDate: "2026-09-04",
      maturityDate: "2026-08-01",
      installmentAmountPaise: 100_000,
      installments: [],
      createdAt: new Date("2026-09-04T10:00:00+05:30"),
    },
  ]);

  const comparison = await buildSchemePerformanceReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
    }),
  );
  assert.equal(comparison.title, "Scheme performance comparison");
  assert.equal(comparison.rows.length, 2);

  const detail = await buildSchemePerformanceReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
      planId: planA._id,
    }),
  );
  assert.match(detail.title, /Gold 11/);
  assert.ok(detail.charts.enrolmentTrend);
  assert.ok(detail.charts.statusDistribution);
});

test("scheme performance report scopes branch managers to their showroom", async () => {
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
  });
  const otherBranch = await Branch.create({
    _id: createId("branch"),
    tenantId: tenant._id,
    name: "Thrissur Showroom",
    code: "TRSR",
    active: true,
  });
  const plan = await SchemePlan.create({
    _id: createId("schemePlan"),
    tenantId: tenant._id,
    name: "Gold 11",
    code: "G11",
    status: "ACTIVE",
    paymentPattern: PaymentPattern.FIXED,
    valueBasis: ValueBasis.CASH,
    durationMonths: 11,
    installmentCount: 11,
  });
  const schemeA = createId("scheme");
  const schemeB = createId("scheme");
  await Scheme.create([
    {
      _id: schemeA,
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: createId("customer"),
      planId: plan._id,
      enrollmentNumber: "ENR-SP-A",
      planSnapshot: { name: "Gold 11", installmentCount: 11 },
      valueBasis: ValueBasis.CASH,
      paymentPattern: PaymentPattern.FIXED,
      status: SchemeStatus.ACTIVE,
      startDate: "2026-09-02",
      maturityDate: "2026-08-01",
      installmentAmountPaise: 100_000,
      installments: [],
      createdAt: new Date("2026-09-02T10:00:00+05:30"),
    },
    {
      _id: schemeB,
      tenantId: tenant._id,
      branchId: otherBranch._id,
      customerId: createId("customer"),
      planId: plan._id,
      enrollmentNumber: "ENR-SP-B",
      planSnapshot: { name: "Gold 11", installmentCount: 11 },
      valueBasis: ValueBasis.CASH,
      paymentPattern: PaymentPattern.FIXED,
      status: SchemeStatus.ACTIVE,
      startDate: "2026-09-03",
      maturityDate: "2026-08-01",
      installmentAmountPaise: 100_000,
      installments: [],
      createdAt: new Date("2026-09-03T10:00:00+05:30"),
    },
  ]);
  await Payment.create([
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: schemeA,
      customerId: createId("customer"),
      receiptNumber: "RCP-SP-A",
      amountPaise: 200_000,
      mode: "CASH",
      source: PaymentSource.PORTAL,
      paidAt: new Date("2026-09-02T10:00:00+05:30"),
    },
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: otherBranch._id,
      schemeId: schemeB,
      customerId: createId("customer"),
      receiptNumber: "RCP-SP-B",
      amountPaise: 900_000,
      mode: "CASH",
      source: PaymentSource.PORTAL,
      paidAt: new Date("2026-09-03T10:00:00+05:30"),
    },
  ]);

  const ownerComparison = await buildSchemePerformanceReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
      planId: "ALL",
    }),
  );
  assert.equal(
    ownerComparison.rows.find((row) => row.key === plan._id)?.collected?.amountPaise,
    1_100_000,
  );

  const branchComparison = await buildSchemePerformanceReport({
    auth: {
      id: user._id,
      tenantId: tenant._id,
      type: "TENANT_USER",
      role: TenantRole.BRANCH_MANAGER,
    },
    scope: { tenantId: tenant._id, branchId: branch._id },
    query: {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
      planId: "ALL",
    },
  });
  assert.equal(
    branchComparison.rows.find((row) => row.key === plan._id)?.collected?.amountPaise,
    200_000,
  );

  const planDetail = await buildSchemePerformanceReport({
    auth: {
      id: user._id,
      tenantId: tenant._id,
      type: "TENANT_USER",
      role: TenantRole.BRANCH_MANAGER,
    },
    scope: { tenantId: tenant._id, branchId: branch._id },
    query: {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
      planId: plan._id,
    },
  });
  assert.equal(planDetail.rows.length, 1);
  assert.equal(planDetail.rows[0]?.key, branch._id);
  assert.equal(planDetail.rows[0]?.collected?.amountPaise, 200_000);
});

test("customer performance report compares customers and supports ledger detail", async () => {
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
  });
  const [customerA, customerB] = await Customer.create([
    {
      _id: createId("customer"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerNumber: "C-CP-1",
      name: "Anu Menon",
      mobile: "+919811100101",
      status: "ACTIVE",
      createdAt: new Date("2026-09-01T10:00:00+05:30"),
    },
    {
      _id: createId("customer"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerNumber: "C-CP-2",
      name: "Ravi Kumar",
      mobile: "+919811100102",
      status: "ACTIVE",
      createdAt: new Date("2026-09-03T10:00:00+05:30"),
    },
  ]);
  const schemeA = createId("scheme");
  const schemeB = createId("scheme");
  await Scheme.create([
    {
      _id: schemeA,
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: customerA._id,
      planId: createId("schemePlan"),
      enrollmentNumber: "ENR-CP-1",
      planSnapshot: { name: "Gold 11", installmentCount: 11 },
      valueBasis: ValueBasis.CASH,
      paymentPattern: PaymentPattern.FIXED,
      status: SchemeStatus.ACTIVE,
      startDate: "2026-09-02",
      maturityDate: "2026-08-01",
      installmentAmountPaise: 100_000,
      installments: [],
      createdAt: new Date("2026-09-02T10:00:00+05:30"),
    },
    {
      _id: schemeB,
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: customerB._id,
      planId: createId("schemePlan"),
      enrollmentNumber: "ENR-CP-2",
      planSnapshot: { name: "Gold 11", installmentCount: 11 },
      valueBasis: ValueBasis.CASH,
      paymentPattern: PaymentPattern.FIXED,
      status: SchemeStatus.ACTIVE,
      startDate: "2026-09-04",
      maturityDate: "2026-08-01",
      installmentAmountPaise: 100_000,
      installments: [],
      createdAt: new Date("2026-09-04T10:00:00+05:30"),
    },
  ]);
  await Payment.create([
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: schemeA,
      customerId: customerA._id,
      receiptNumber: "RCP-CP-1",
      amountPaise: 200_000,
      mode: "CASH",
      source: "PORTAL",
      paidAt: new Date("2026-09-02T10:00:00+05:30"),
    },
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: schemeB,
      customerId: customerB._id,
      receiptNumber: "RCP-CP-2",
      amountPaise: 100_000,
      mode: "CASH",
      source: "PORTAL",
      paidAt: new Date("2026-09-04T10:00:00+05:30"),
    },
  ]);
  await LedgerEntry.create({
    _id: createId("ledger"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: schemeA,
    customerId: customerA._id,
    type: LedgerEntryType.INSTALLMENT_PAYMENT,
    sequence: 1,
    amountPaise: 200_000,
    effectiveAt: new Date("2026-09-02T10:00:00+05:30"),
  });

  const comparison = await buildCustomerPerformanceReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
    }),
  );
  assert.equal(comparison.title, "Customer performance overview");
  assert.equal(comparison.rows.length, 2);
  assert.ok(comparison.charts.collectionByCustomer);
  assert.ok(comparison.charts.registrationTrend);

  const detail = await buildCustomerPerformanceReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
      customerId: customerA._id,
    }),
  );
  assert.match(detail.title, /Anu Menon/);
  assert.equal(detail.columns.some((col) => col.key === "balance"), true);
  assert.equal(detail.rows.length, 1);
});

const UI_REPORT_KEYS = [
  "COLLECTION",
  "ENROLMENT",
  "OUTSTANDING",
  "MATURITY_REDEMPTION",
  "GOLD_ACCRUAL",
  "CUSTOMER_PERFORMANCE",
  "STAFF_PERFORMANCE",
  "CASH_HANDOVER",
  "REMINDER_DELIVERY",
  "WHATSAPP_USAGE",
  "SCHEME_REGISTER",
  "DEFAULTER",
  "BRANCH_PERFORMANCE",
  "SCHEME_PERFORMANCE",
];

function assertReportEnvelope(result, reportKey) {
  assert.equal(result.reportKey, reportKey);
  assert.ok(Array.isArray(result.summary));
  assert.ok(result.charts && typeof result.charts === "object");
  assert.ok(Array.isArray(result.columns));
  assert.ok(Array.isArray(result.rows));
  assert.ok(result.meta && typeof result.meta === "object");
}

test("all UI report keys build a valid envelope on empty tenant", async () => {
  const { tenant, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
  });
  const req = reportReq(user, tenant, {
    period: "CUSTOM",
    from: "2026-09-01",
    to: "2026-09-05",
  });

  for (const reportKey of UI_REPORT_KEYS) {
    const result = await buildAdminReport(req, reportKey);
    assert.ok(result, `missing builder for ${reportKey}`);
    assertReportEnvelope(result, reportKey);
  }
});

test("collection report summary and totals match branch rows", async () => {
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
  });
  const schemeId = createId("scheme");
  const customerId = createId("customer");
  await Scheme.create({
    _id: schemeId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    planId: createId("schemePlan"),
    enrollmentNumber: "ENR-COL-1",
    planSnapshot: { name: "Gold 11", installmentCount: 11 },
    valueBasis: ValueBasis.CASH,
    paymentPattern: PaymentPattern.FIXED,
    status: SchemeStatus.ACTIVE,
    startDate: "2026-09-01",
    maturityDate: "2026-08-01",
    installmentAmountPaise: 100_000,
    installments: [],
  });
  await Payment.create([
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId,
      customerId,
      receiptNumber: "RCP-COL-1",
      amountPaise: 300_000,
      mode: "CASH",
      source: PaymentSource.PORTAL,
      status: PaymentStatus.SUCCESS,
      paidAt: new Date("2026-09-02T10:00:00+05:30"),
    },
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId,
      customerId,
      receiptNumber: "RCP-COL-2",
      amountPaise: 200_000,
      mode: "UPI",
      source: PaymentSource.PORTAL,
      status: PaymentStatus.SUCCESS,
      paidAt: new Date("2026-09-03T10:00:00+05:30"),
    },
  ]);

  const result = await buildCollectionReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
    }),
  );

  const totalCollected = result.summary.find((row) => row.key === "TOTAL_COLLECTED");
  assert.equal(totalCollected?.value?.amountPaise, 500_000);
  assert.equal(result.totalsRow?.total?.amountPaise, 500_000);
  assert.equal(result.totalsRow?.cash?.amountPaise, 300_000);
  assert.equal(result.totalsRow?.upi?.amountPaise, 200_000);
  assert.equal(result.charts.trend.series[0].data.length, 5);
});

test("collection report with branchId=ALL returns all branches even when scope is narrowed", async () => {
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
  });
  const otherBranch = await Branch.create({
    _id: createId("branch"),
    tenantId: tenant._id,
    name: "Thrissur Showroom",
    code: "TRSR",
    active: true,
  });
  const schemeA = createId("scheme");
  const schemeB = createId("scheme");
  await Scheme.create([
    {
      _id: schemeA,
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: createId("customer"),
      planId: createId("schemePlan"),
      enrollmentNumber: "ENR-COL-A",
      planSnapshot: { name: "Gold 11", installmentCount: 11 },
      valueBasis: ValueBasis.CASH,
      paymentPattern: PaymentPattern.FIXED,
      status: SchemeStatus.ACTIVE,
      startDate: "2026-09-01",
      maturityDate: "2026-08-01",
      installmentAmountPaise: 100_000,
      installments: [],
    },
    {
      _id: schemeB,
      tenantId: tenant._id,
      branchId: otherBranch._id,
      customerId: createId("customer"),
      planId: createId("schemePlan"),
      enrollmentNumber: "ENR-COL-B",
      planSnapshot: { name: "Gold 11", installmentCount: 11 },
      valueBasis: ValueBasis.CASH,
      paymentPattern: PaymentPattern.FIXED,
      status: SchemeStatus.ACTIVE,
      startDate: "2026-09-01",
      maturityDate: "2026-08-01",
      installmentAmountPaise: 100_000,
      installments: [],
    },
  ]);
  await Payment.create([
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: schemeA,
      customerId: createId("customer"),
      receiptNumber: "RCP-COL-A",
      amountPaise: 250_000,
      mode: "CASH",
      source: PaymentSource.PORTAL,
      status: PaymentStatus.SUCCESS,
      paidAt: new Date("2026-09-02T10:00:00+05:30"),
    },
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: otherBranch._id,
      schemeId: schemeB,
      customerId: createId("customer"),
      receiptNumber: "RCP-COL-B",
      amountPaise: 500_000,
      mode: "UPI",
      source: PaymentSource.PORTAL,
      status: PaymentStatus.SUCCESS,
      paidAt: new Date("2026-09-03T10:00:00+05:30"),
    },
  ]);

  const scopedSingle = await buildCollectionReport({
    auth: {
      id: user._id,
      tenantId: tenant._id,
      type: "TENANT_USER",
      role: TenantRole.TENANT_OWNER,
    },
    scope: { tenantId: tenant._id, branchId: branch._id },
    query: {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
      branchId: branch._id,
    },
  });
  assert.equal(scopedSingle.rows.length, 1);

  const allBranches = await buildCollectionReport({
    auth: {
      id: user._id,
      tenantId: tenant._id,
      type: "TENANT_USER",
      role: TenantRole.TENANT_OWNER,
    },
    scope: { tenantId: tenant._id, branchId: branch._id },
    query: {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
      branchId: "ALL",
    },
  });
  assert.equal(allBranches.rows.length, 2);
  assert.equal(allBranches.summary.find((row) => row.key === "TOTAL_COLLECTED")?.value?.amountPaise, 750_000);
});

test("outstanding report aggregates overdue rows and portfolio summary", async () => {
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
  });
  const customerId = createId("customer");
  await Customer.create({
    _id: customerId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: "C-OUT-1",
    name: "Overdue Customer",
    mobile: "+919811100201",
    status: "ACTIVE",
  });
  await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    planId: createId("schemePlan"),
    enrollmentNumber: "ENR-OUT-1",
    planSnapshot: { name: "Gold 11", installmentCount: 11 },
    valueBasis: ValueBasis.CASH,
    paymentPattern: PaymentPattern.FIXED,
    status: SchemeStatus.ACTIVE,
    startDate: "2026-08-01",
    maturityDate: "2026-07-01",
    installmentAmountPaise: 100_000,
    installments: [
      {
        number: 1,
        dueDate: "2026-08-01",
        amountPaise: 100_000,
        paidPaise: 0,
        status: "OVERDUE",
      },
      {
        number: 2,
        dueDate: "2026-10-01",
        amountPaise: 100_000,
        paidPaise: 0,
        status: "DUE",
      },
    ],
  });

  const result = await buildOutstandingReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
    }),
  );

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].overdueAmount.amountPaise, 100_000);
  const outstanding = result.summary.find((row) => row.key === "OUTSTANDING");
  assert.equal(outstanding?.value?.amountPaise, 100_000);
  assert.ok(result.charts.ageing.series[0].data.some((point) => point.y === 100_000));
});

test("defaulter report recovery matches paid installments", async () => {
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
  });
  const customerId = createId("customer");
  await Customer.create({
    _id: customerId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: "C-DEF-1",
    name: "Defaulted Customer",
    mobile: "+919811100301",
    status: "ACTIVE",
  });
  await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    planId: createId("schemePlan"),
    enrollmentNumber: "ENR-DEF-1",
    planSnapshot: { name: "Gold 11", installmentCount: 11 },
    valueBasis: ValueBasis.CASH,
    paymentPattern: PaymentPattern.FIXED,
    status: SchemeStatus.DEFAULTED,
    startDate: "2026-06-01",
    maturityDate: "2026-05-01",
    installmentAmountPaise: 100_000,
    installments: [
      {
        number: 1,
        dueDate: "2026-06-01",
        amountPaise: 100_000,
        paidPaise: 60_000,
        status: "PARTIALLY_PAID",
      },
      {
        number: 2,
        dueDate: "2026-07-01",
        amountPaise: 100_000,
        paidPaise: 40_000,
        status: "OVERDUE",
      },
    ],
    updatedAt: new Date("2026-09-01T10:00:00+05:30"),
  });

  const result = await buildDefaulterReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
    }),
  );

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].recoveryValue.amountPaise, 100_000);
  const recovery = result.summary.find((row) => row.key === "RECOVERY");
  assert.equal(recovery?.value?.amountPaise, 100_000);
});

test("staff performance report totals collected by staff", async () => {
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
  });
  const staff = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branch._id,
    role: TenantRole.BRANCH_STAFF,
    name: "Collector One",
    mobile: "+919811100401",
    passwordHash: "hash",
    status: UserStatus.ACTIVE,
  });
  const schemeId = createId("scheme");
  await Scheme.create({
    _id: schemeId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    planId: createId("schemePlan"),
    enrollmentNumber: "ENR-STF-1",
    planSnapshot: { name: "Gold 11", installmentCount: 11 },
    valueBasis: ValueBasis.CASH,
    paymentPattern: PaymentPattern.FIXED,
    status: SchemeStatus.ACTIVE,
    startDate: "2026-09-02",
    maturityDate: "2026-08-01",
    installmentAmountPaise: 100_000,
    installments: [],
    createdBy: staff._id,
    createdAt: new Date("2026-09-02T10:00:00+05:30"),
  });
  await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId,
    customerId: createId("customer"),
    receiptNumber: "RCP-STF-1",
    amountPaise: 150_000,
    mode: "CASH",
    source: PaymentSource.PORTAL,
    status: PaymentStatus.SUCCESS,
    collectedBy: staff._id,
    paidAt: new Date("2026-09-02T10:00:00+05:30"),
  });

  const result = await buildStaffPerformanceReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
    }),
  );

  const staffRow = result.rows.find((row) => row.key === staff._id);
  assert.equal(staffRow?.collected?.amountPaise, 150_000);
  assert.equal(staffRow?.enrolments, 1);
  const totalCollected = result.summary.find((row) => row.key === "TOTAL_COLLECTED");
  assert.equal(totalCollected?.value?.amountPaise, 150_000);
});

test("reminder delivery report computes delivery rate from message stats", async () => {
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
  });
  await Message.create([
    {
      _id: createId("msg"),
      tenantId: tenant._id,
      branchId: branch._id,
      type: MessageType.PAYMENT_DUE,
      channel: MessageChannel.WHATSAPP,
      status: MessageStatus.DELIVERED,
      createdAt: new Date("2026-09-02T10:00:00+05:30"),
    },
    {
      _id: createId("msg"),
      tenantId: tenant._id,
      branchId: branch._id,
      type: MessageType.PAYMENT_DUE,
      channel: MessageChannel.WHATSAPP,
      status: MessageStatus.FAILED,
      createdAt: new Date("2026-09-03T10:00:00+05:30"),
    },
    {
      _id: createId("msg"),
      tenantId: tenant._id,
      branchId: branch._id,
      type: MessageType.PAYMENT_SUCCESS,
      channel: MessageChannel.WHATSAPP,
      status: MessageStatus.READ,
      createdAt: new Date("2026-09-04T10:00:00+05:30"),
    },
  ]);

  const result = await buildReminderDeliveryReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
    }),
  );

  const dueRow = result.rows.find((row) => row.key === "PAYMENT_DUE");
  assert.equal(dueRow?.sent, 2);
  assert.equal(dueRow?.delivered, 1);
  assert.equal(dueRow?.failed, 1);
  assert.equal(dueRow?.deliveryRate, 50);
  const delivered = result.summary.find((row) => row.key === "DELIVERED");
  assert.equal(delivered?.value, 2);
});

test("whatsapp usage report buckets messages by category", async () => {
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
  });
  await Message.create([
    {
      _id: createId("msg"),
      tenantId: tenant._id,
      branchId: branch._id,
      type: MessageType.OTP,
      channel: MessageChannel.WHATSAPP,
      status: MessageStatus.DELIVERED,
      createdAt: new Date("2026-09-02T10:00:00+05:30"),
    },
    {
      _id: createId("msg"),
      tenantId: tenant._id,
      branchId: branch._id,
      type: MessageType.SCHEME_JOINED,
      channel: MessageChannel.WHATSAPP,
      status: MessageStatus.DELIVERED,
      createdAt: new Date("2026-09-02T11:00:00+05:30"),
    },
    {
      _id: createId("msg"),
      tenantId: tenant._id,
      branchId: branch._id,
      type: MessageType.PAYMENT_SUCCESS,
      channel: MessageChannel.WHATSAPP,
      status: MessageStatus.DELIVERED,
      createdAt: new Date("2026-09-03T10:00:00+05:30"),
    },
  ]);

  const result = await buildWhatsappUsageReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
    }),
  );

  const totalMessages = result.summary.find((row) => row.key === "CONVERSATIONS");
  assert.equal(totalMessages?.value, 3);
  const categoryTotal = result.rows.reduce((sum, row) => sum + row.total, 0);
  assert.equal(categoryTotal, 3);
});

test("cash handover report lists staff across branches when branchId=ALL", async () => {
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
  });
  const otherBranch = await Branch.create({
    _id: createId("branch"),
    tenantId: tenant._id,
    name: "Thrissur Showroom",
    code: "TRSR",
    active: true,
  });
  const [staffA, staffB] = await User.create([
    {
      _id: createId("user"),
      type: UserType.TENANT_USER,
      tenantId: tenant._id,
      branchId: branch._id,
      role: TenantRole.BRANCH_STAFF,
      name: "Staff HQ",
      mobile: "+919811100601",
      passwordHash: "hash",
      status: UserStatus.ACTIVE,
    },
    {
      _id: createId("user"),
      type: UserType.TENANT_USER,
      tenantId: tenant._id,
      branchId: otherBranch._id,
      role: TenantRole.BRANCH_STAFF,
      name: "Staff TRSR",
      mobile: "+919811100602",
      passwordHash: "hash",
      status: UserStatus.ACTIVE,
    },
  ]);
  const schemeId = createId("scheme");
  await Scheme.create({
    _id: schemeId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    planId: createId("schemePlan"),
    enrollmentNumber: "ENR-CSH-ALL-1",
    planSnapshot: { name: "Gold 11", installmentCount: 11 },
    valueBasis: ValueBasis.CASH,
    paymentPattern: PaymentPattern.FIXED,
    status: SchemeStatus.ACTIVE,
    startDate: "2026-09-01",
    maturityDate: "2026-08-01",
    installmentAmountPaise: 100_000,
    installments: [],
  });
  await Payment.create([
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId,
      customerId: createId("customer"),
      receiptNumber: "RCP-CSH-ALL-1",
      amountPaise: 75_000,
      mode: "CASH",
      source: PaymentSource.PORTAL,
      status: PaymentStatus.SUCCESS,
      collectedBy: staffA._id,
      paidAt: new Date("2026-09-02T10:00:00+05:30"),
    },
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: otherBranch._id,
      schemeId,
      customerId: createId("customer"),
      receiptNumber: "RCP-CSH-ALL-2",
      amountPaise: 50_000,
      mode: "CASH",
      source: PaymentSource.PORTAL,
      status: PaymentStatus.SUCCESS,
      collectedBy: staffB._id,
      paidAt: new Date("2026-09-03T10:00:00+05:30"),
    },
  ]);

  const scoped = await buildCashHandoverReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
      branchId: branch._id,
    }),
  );
  assert.equal(scoped.rows.length, 1);

  const allBranches = await buildCashHandoverReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
      branchId: "ALL",
    }),
  );
  assert.equal(allBranches.rows.length, 2);
  assert.equal(
    allBranches.summary.find((row) => row.key === "COLLECTED")?.value?.amountPaise,
    125_000,
  );
});

test("cash handover report builds summary from staff cash balances", async () => {
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
  });
  const staff = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branch._id,
    role: TenantRole.BRANCH_STAFF,
    name: "Cash Staff",
    mobile: "+919811100501",
    passwordHash: "hash",
    status: UserStatus.ACTIVE,
  });
  const schemeId = createId("scheme");
  await Scheme.create({
    _id: schemeId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    planId: createId("schemePlan"),
    enrollmentNumber: "ENR-CSH-1",
    planSnapshot: { name: "Gold 11", installmentCount: 11 },
    valueBasis: ValueBasis.CASH,
    paymentPattern: PaymentPattern.FIXED,
    status: SchemeStatus.ACTIVE,
    startDate: "2026-09-01",
    maturityDate: "2026-08-01",
    installmentAmountPaise: 100_000,
    installments: [],
  });
  await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId,
    customerId: createId("customer"),
    receiptNumber: "RCP-CSH-1",
    amountPaise: 75_000,
    mode: "CASH",
    source: PaymentSource.PORTAL,
    status: PaymentStatus.SUCCESS,
    collectedBy: staff._id,
    paidAt: new Date("2026-09-02T10:00:00+05:30"),
  });

  const result = await buildCashHandoverReport(
    reportReq(user, tenant, {
      period: "CUSTOM",
      from: "2026-09-01",
      to: "2026-09-05",
    }),
  );

  assertReportEnvelope(result, "CASH_HANDOVER");
  const collected = result.summary.find((row) => row.key === "COLLECTED");
  assert.equal(collected?.value?.amountPaise, 75_000);
  assert.equal(result.rows.find((row) => row.key === staff._id)?.collected?.amountPaise, 75_000);
});
