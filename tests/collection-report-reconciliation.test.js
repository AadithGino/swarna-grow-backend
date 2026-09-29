import test from "node:test";
import assert from "node:assert/strict";
import {
  GatewayRefundStatus,
  PaymentStatus,
  SchemePlanStatus,
  SchemeStatus,
  TenantRole,
  ValueBasis,
} from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { Branch, Payment, PaymentRefund, Scheme, SchemePlan } from "../src/models/index.js";
import { buildCollectionReport } from "../src/services/report-builders/collection.report.js";
import { collectionSummary } from "../src/services/collection-summary.js";
import { aggregateCollectionByBranch } from "../src/lib/collection-period-aggregation.js";
import { collectionPeriodBaseMatch } from "../src/lib/collection-period-aggregation.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function mkReq(ctx, from, to, extra = {}) {
  return {
    auth: { tenantId: ctx.tenant._id, id: ctx.user._id, role: ctx.user.role, type: "TENANT_USER" },
    scope: { tenantId: ctx.tenant._id },
    query: { from, to, period: "CUSTOM", ...extra },
  };
}

test("feb-only period: summary net, table total and trend agree after jan payment feb refund", async () => {
  const ctx = await seedTenantUser();
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: ctx.tenant._id,
    branchId: ctx.branch._id,
    customerId: createId("customer"),
    schemeId: createId("scheme"),
    receiptNumber: "R-1K",
    mode: "UPI",
    status: PaymentStatus.PARTIALLY_REFUNDED,
    amountPaise: 1_000_000,
    paidAt: new Date("2026-01-12T12:00:00+05:30"),
    collectedBy: ctx.user._id,
    source: "CUSTOMER_APP",
  });
  await PaymentRefund.create({
    _id: createId("paymentRefund"),
    tenantId: ctx.tenant._id,
    paymentId,
    amountPaise: 100_000,
    status: GatewayRefundStatus.COMPLETED,
    completedAt: new Date("2026-02-08T10:00:00+05:30"),
  });

  const febReq = mkReq(ctx, "2026-02-01", "2026-02-28");
  const summary = await collectionSummary(febReq);
  const report = await buildCollectionReport(febReq);
  const netLine = report.summary.find((r) => r.key === "TOTAL_COLLECTED");
  assert.equal(summary.grossAmountPaise, 0);
  assert.equal(summary.refundOutflowPaise, 100_000);
  assert.equal(summary.amountPaise, -100_000);
  assert.equal(netLine.value.amountPaise, -100_000);
  assert.equal(report.totalsRow.total.amountPaise, -100_000);
  assert.equal(report.charts.trend.series[0].data.some((p) => p.y === -100_000), true);
});

test("planId filter excludes unrelated scheme refunds from net", async () => {
  const ctx = await seedTenantUser();
  const planA = await SchemePlan.create({
    _id: createId("schemePlan"),
    tenantId: ctx.tenant._id,
    code: "PA",
    name: "Plan A",
    status: SchemePlanStatus.ACTIVE,
    paymentPattern: "FIXED",
    valueBasis: ValueBasis.CASH,
    durationMonths: 12,
    installmentCount: 12,
  });
  const planB = await SchemePlan.create({
    _id: createId("schemePlan"),
    tenantId: ctx.tenant._id,
    code: "PB",
    name: "Plan B",
    status: SchemePlanStatus.ACTIVE,
    paymentPattern: "FIXED",
    valueBasis: ValueBasis.CASH,
    durationMonths: 12,
    installmentCount: 12,
  });
  const schemeA = createId("scheme");
  const schemeB = createId("scheme");
  await Scheme.create([
    {
      _id: schemeA,
      tenantId: ctx.tenant._id,
      branchId: ctx.branch._id,
      customerId: createId("customer"),
      planId: planA._id,
      enrollmentNumber: "A1",
      planSnapshot: {},
      valueBasis: ValueBasis.CASH,
      paymentPattern: "FIXED",
      status: SchemeStatus.ACTIVE,
      startDate: "2026-01-01",
      maturityDate: "2027-01-01",
    },
    {
      _id: schemeB,
      tenantId: ctx.tenant._id,
      branchId: ctx.branch._id,
      customerId: createId("customer"),
      planId: planB._id,
      enrollmentNumber: "B1",
      planSnapshot: {},
      valueBasis: ValueBasis.CASH,
      paymentPattern: "FIXED",
      status: SchemeStatus.ACTIVE,
      startDate: "2026-01-01",
      maturityDate: "2027-01-01",
    },
  ]);
  const payA = createId("payment");
  const payB = createId("payment");
  await Payment.insertMany([
    {
      _id: payA,
      tenantId: ctx.tenant._id,
      branchId: ctx.branch._id,
      schemeId: schemeA,
      customerId: createId("customer"),
      receiptNumber: "RA",
      mode: "UPI",
      status: PaymentStatus.SUCCESS,
      amountPaise: 500_000,
      paidAt: new Date("2026-02-01T10:00:00+05:30"),
      source: "CUSTOMER_APP",
    },
    {
      _id: payB,
      tenantId: ctx.tenant._id,
      branchId: ctx.branch._id,
      schemeId: schemeB,
      customerId: createId("customer"),
      receiptNumber: "RB",
      mode: "UPI",
      status: PaymentStatus.PARTIALLY_REFUNDED,
      amountPaise: 500_000,
      paidAt: new Date("2026-01-15T10:00:00+05:30"),
      source: "CUSTOMER_APP",
    },
  ]);
  await PaymentRefund.create({
    _id: createId("paymentRefund"),
    tenantId: ctx.tenant._id,
    paymentId: payB,
    amountPaise: 200_000,
    status: GatewayRefundStatus.COMPLETED,
    completedAt: new Date("2026-02-10T10:00:00+05:30"),
  });

  const febPlanA = await collectionSummary(mkReq(ctx, "2026-02-01", "2026-02-28", { planId: planA._id }));
  assert.equal(febPlanA.grossAmountPaise, 500_000);
  assert.equal(febPlanA.refundOutflowPaise, 0);
  const febPlanB = await collectionSummary(mkReq(ctx, "2026-02-01", "2026-02-28", { planId: planB._id }));
  assert.equal(febPlanB.grossAmountPaise, 0);
  assert.equal(febPlanB.refundOutflowPaise, 200_000);
});

test("refund-only branch appears in branch aggregation for the period", async () => {
  const ctx = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const branchB = createId("branch");
  await Branch.create({
    _id: branchB,
    tenantId: ctx.tenant._id,
    code: "REF",
    name: "Refund Only",
    active: true,
  });
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: ctx.tenant._id,
    branchId: branchB,
    customerId: createId("customer"),
    schemeId: createId("scheme"),
    receiptNumber: "R-OLD",
    mode: "CASH",
    status: PaymentStatus.PARTIALLY_REFUNDED,
    amountPaise: 300_000,
    paidAt: new Date("2026-01-05T10:00:00+05:30"),
    source: "CUSTOMER_APP",
  });
  await PaymentRefund.create({
    _id: createId("paymentRefund"),
    tenantId: ctx.tenant._id,
    paymentId,
    amountPaise: 50_000,
    status: GatewayRefundStatus.COMPLETED,
    completedAt: new Date("2026-02-02T11:00:00+05:30"),
  });
  const base = collectionPeriodBaseMatch({ tenantId: ctx.tenant._id });
  const rows = await aggregateCollectionByBranch(base, { from: "2026-02-01", to: "2026-02-28" });
  const hit = rows.find((r) => r.key === branchB);
  assert.ok(hit);
  assert.equal(hit.value, -50_000);
});

test("march report summary and table match collection summary for split refunds", async () => {
  const ctx = await seedTenantUser();
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: ctx.tenant._id,
    branchId: ctx.branch._id,
    customerId: createId("customer"),
    schemeId: createId("scheme"),
    receiptNumber: "R-M",
    mode: "ONLINE_GATEWAY",
    status: PaymentStatus.PARTIALLY_REFUNDED,
    amountPaise: 1_000_000,
    paidAt: new Date("2026-01-10T12:00:00+05:30"),
    source: "CUSTOMER_APP",
  });
  await PaymentRefund.insertMany([
    {
      _id: createId("paymentRefund"),
      tenantId: ctx.tenant._id,
      paymentId,
      amountPaise: 100_000,
      status: GatewayRefundStatus.COMPLETED,
      completedAt: new Date("2026-02-05T10:00:00+05:30"),
    },
    {
      _id: createId("paymentRefund"),
      tenantId: ctx.tenant._id,
      paymentId,
      amountPaise: 50_000,
      status: GatewayRefundStatus.COMPLETED,
      completedAt: new Date("2026-03-08T11:00:00+05:30"),
    },
  ]);
  const jan = await collectionSummary(mkReq(ctx, "2026-01-01", "2026-01-31"));
  const marReq = mkReq(ctx, "2026-03-01", "2026-03-31");
  const mar = await collectionSummary(marReq);
  const report = await buildCollectionReport(marReq);
  assert.equal(jan.grossAmountPaise, 1_000_000);
  assert.equal(mar.refundOutflowPaise, 50_000);
  assert.equal(report.summary.find((r) => r.key === "TOTAL_COLLECTED").value.amountPaise, mar.amountPaise);
  assert.equal(report.totalsRow.total.amountPaise, mar.amountPaise);
});

test("pending gateway refund does not affect feb outflow", async () => {
  const ctx = await seedTenantUser();
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: ctx.tenant._id,
    branchId: ctx.branch._id,
    customerId: createId("customer"),
    schemeId: createId("scheme"),
    receiptNumber: "R-P",
    mode: "UPI",
    status: PaymentStatus.SUCCESS,
    amountPaise: 100_000,
    paidAt: new Date("2026-01-01T10:00:00+05:30"),
    source: "CUSTOMER_APP",
  });
  await PaymentRefund.create({
    _id: createId("paymentRefund"),
    tenantId: ctx.tenant._id,
    paymentId,
    amountPaise: 40_000,
    status: GatewayRefundStatus.PENDING,
  });
  const feb = await collectionSummary(mkReq(ctx, "2026-02-01", "2026-02-28"));
  assert.equal(feb.refundOutflowPaise, 0);
});
