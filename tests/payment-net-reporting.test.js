import test from "node:test";
import assert from "node:assert/strict";
import { GatewayRefundStatus, PaymentStatus } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import {
  netAmountPaiseFromDoc,
  netWeightMgFromDoc,
} from "../src/lib/payment-net-aggregation.js";
import { Payment, PaymentRefund } from "../src/models/index.js";
import { buildCollectionReport } from "../src/services/report-builders/collection.report.js";
import { collectionSummary } from "../src/services/collection-summary.js";
import { dashboard } from "../src/services/reporting.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("net amount and weight helpers", () => {
  assert.equal(netAmountPaiseFromDoc({ amountPaise: 10_000_000, refundedAmountPaise: 0 }), 10_000_000);
  assert.equal(netAmountPaiseFromDoc({ amountPaise: 10_000_000, refundedAmountPaise: 2_500_000 }), 7_500_000);
  assert.equal(netAmountPaiseFromDoc({ amountPaise: 10_000_000, refundedAmountPaise: 10_000_000 }), 0);
  assert.equal(netWeightMgFromDoc({ weightMg: 1000, refundedWeightMg: 250 }), 750);
});

test("dashboard and collection summary agree on net totals with partial refund", async () => {
  const { tenant, branch, user } = await seedTenantUser();
  const paidAt = new Date();
  paidAt.setHours(12, 0, 0, 0);
  const partialId = createId("payment");
  const reversedId = createId("payment");
  await Payment.insertMany([
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: createId("customer"),
      schemeId: createId("scheme"),
      receiptNumber: "R-100",
      mode: "UPI",
      status: PaymentStatus.SUCCESS,
      amountPaise: 10_000_000,
      refundedAmountPaise: 0,
      paidAt,
      collectedBy: user._id,
      source: "CUSTOMER_APP",
    },
    {
      _id: partialId,
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: createId("customer"),
      schemeId: createId("scheme"),
      receiptNumber: "R-75",
      mode: "CASH",
      status: PaymentStatus.PARTIALLY_REFUNDED,
      amountPaise: 10_000_000,
      refundedAmountPaise: 2_500_000,
      paidAt,
      collectedBy: user._id,
      source: "CUSTOMER_APP",
    },
    {
      _id: reversedId,
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: createId("customer"),
      schemeId: createId("scheme"),
      receiptNumber: "R-0",
      mode: "UPI",
      status: PaymentStatus.REVERSED,
      amountPaise: 5_000_000,
      refundedAmountPaise: 5_000_000,
      paidAt,
      reversedAt: paidAt,
      reversalReason: "STAFF_ERROR",
      collectedBy: user._id,
      source: "CUSTOMER_APP",
    },
  ]);
  await PaymentRefund.create({
    _id: createId("paymentRefund"),
    tenantId: tenant._id,
    paymentId: partialId,
    amountPaise: 2_500_000,
    status: GatewayRefundStatus.COMPLETED,
    completedAt: paidAt,
  });
  const req = {
    auth: { tenantId: tenant._id, id: user._id, role: user.role, type: "TENANT_USER" },
    scope: { tenantId: tenant._id },
    query: { period: "TODAY" },
  };
  const summary = await collectionSummary(req);
  const dash = await dashboard(req);
  const expectedNet = 17_500_000;
  const expectedCount = 3;
  assert.equal(summary.amountPaise, expectedNet);
  assert.equal(summary.count, expectedCount);
  assert.equal(dash.today.amountPaise, expectedNet);
  assert.equal(dash.today.count, expectedCount);
  const cashMode = summary.byMode.find((row) => row.mode === "CASH");
  const upiMode = summary.byMode.find((row) => row.mode === "UPI");
  assert.equal(cashMode.amountPaise, 7_500_000);
  assert.equal(upiMode.amountPaise, 10_000_000);
});

test("collection summary keeps prior-month gross when refund happens later", async () => {
  const { tenant, branch, user } = await seedTenantUser();
  const janPaidAt = new Date("2026-01-15T12:00:00+05:30");
  const febRefundAt = new Date("2026-02-03T10:00:00+05:30");
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    schemeId: createId("scheme"),
    receiptNumber: "R-JAN",
    mode: "UPI",
    status: PaymentStatus.PARTIALLY_REFUNDED,
    amountPaise: 1_000_000,
    refundedAmountPaise: 250_000,
    paidAt: janPaidAt,
    lastRefundedAt: febRefundAt,
    collectedBy: user._id,
    source: "CUSTOMER_APP",
  });
  await PaymentRefund.create({
    _id: createId("paymentRefund"),
    tenantId: tenant._id,
    paymentId,
    amountPaise: 250_000,
    status: GatewayRefundStatus.COMPLETED,
    completedAt: febRefundAt,
  });
  const janReq = {
    auth: { tenantId: tenant._id, id: user._id, role: user.role, type: "TENANT_USER" },
    scope: { tenantId: tenant._id },
    query: { from: "2026-01-01", to: "2026-01-31" },
  };
  const febReq = {
    ...janReq,
    query: { from: "2026-02-01", to: "2026-02-28" },
  };
  const jan = await collectionSummary(janReq);
  const feb = await collectionSummary(febReq);
  assert.equal(jan.grossAmountPaise, 1_000_000);
  assert.equal(jan.refundOutflowPaise, 0);
  assert.equal(jan.amountPaise, 1_000_000);
  assert.equal(feb.grossAmountPaise, 0);
  assert.equal(feb.refundOutflowPaise, 250_000);
  assert.equal(feb.amountPaise, -250_000);
});

test("split gateway refunds stay in completion month; jan gross unchanged after march refund", async () => {
  const { tenant, branch, user } = await seedTenantUser();
  const janPaidAt = new Date("2026-01-10T12:00:00+05:30");
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    schemeId: createId("scheme"),
    receiptNumber: "R-1000",
    mode: "ONLINE_GATEWAY",
    status: PaymentStatus.PARTIALLY_REFUNDED,
    amountPaise: 1_000_000,
    refundedAmountPaise: 150_000,
    paidAt: janPaidAt,
    collectedBy: user._id,
    source: "CUSTOMER_APP",
  });
  await PaymentRefund.insertMany([
    {
      _id: createId("paymentRefund"),
      tenantId: tenant._id,
      paymentId,
      amountPaise: 100_000,
      status: GatewayRefundStatus.COMPLETED,
      completedAt: new Date("2026-02-05T10:00:00+05:30"),
    },
    {
      _id: createId("paymentRefund"),
      tenantId: tenant._id,
      paymentId,
      amountPaise: 50_000,
      status: GatewayRefundStatus.COMPLETED,
      completedAt: new Date("2026-03-08T11:00:00+05:30"),
    },
    {
      _id: createId("paymentRefund"),
      tenantId: tenant._id,
      paymentId,
      amountPaise: 25_000,
      status: GatewayRefundStatus.PENDING,
      completedAt: null,
    },
  ]);
  const mkReq = (from, to) => ({
    auth: { tenantId: tenant._id, id: user._id, role: user.role, type: "TENANT_USER" },
    scope: { tenantId: tenant._id },
    query: { from, to },
  });
  const jan = await collectionSummary(mkReq("2026-01-01", "2026-01-31"));
  const feb = await collectionSummary(mkReq("2026-02-01", "2026-02-28"));
  const mar = await collectionSummary(mkReq("2026-03-01", "2026-03-31"));
  assert.equal(jan.grossAmountPaise, 1_000_000);
  assert.equal(jan.refundOutflowPaise, 0);
  assert.equal(feb.refundOutflowPaise, 100_000);
  assert.equal(mar.refundOutflowPaise, 50_000);
  assert.equal(feb.amountPaise, -100_000);
  assert.equal(mar.amountPaise, -50_000);
  const report = await buildCollectionReport({
    ...mkReq("2026-01-01", "2026-03-31"),
    query: { from: "2026-01-01", to: "2026-03-31" },
  });
  const grossLine = report.summary.find((row) => row.key === "GROSS_COLLECTED");
  const refundLine = report.summary.find((row) => row.key === "REFUND_OUTFLOW");
  assert.equal(grossLine.value.amountPaise, 1_000_000);
  assert.equal(refundLine.value.amountPaise, 150_000);
  const febAgain = await collectionSummary(mkReq("2026-02-01", "2026-02-28"));
  assert.equal(febAgain.refundOutflowPaise, feb.refundOutflowPaise);
});

test("manual cash reversal outflow is dated at reversedAt, not paidAt", async () => {
  const { tenant, branch, user } = await seedTenantUser();
  const paidAt = new Date("2026-01-20T12:00:00+05:30");
  const reversedAt = new Date("2026-02-12T09:00:00+05:30");
  await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    schemeId: createId("scheme"),
    receiptNumber: "R-CASH-REV",
    mode: "CASH",
    status: PaymentStatus.REVERSED,
    amountPaise: 80_000,
    refundedAmountPaise: 80_000,
    paidAt,
    reversedAt,
    reversalReason: "STAFF_ERROR",
    collectedBy: user._id,
    source: "CUSTOMER_APP",
  });
  const jan = await collectionSummary({
    auth: { tenantId: tenant._id, id: user._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id },
    query: { from: "2026-01-01", to: "2026-01-31" },
  });
  const feb = await collectionSummary({
    auth: { tenantId: tenant._id, id: user._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id },
    query: { from: "2026-02-01", to: "2026-02-28" },
  });
  assert.equal(jan.grossAmountPaise, 80_000);
  assert.equal(jan.refundOutflowPaise, 0);
  assert.equal(feb.refundOutflowPaise, 80_000);
});

test("IST midnight boundary assigns refund to correct calendar day", async () => {
  const { tenant, branch, user } = await seedTenantUser();
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    schemeId: createId("scheme"),
    receiptNumber: "R-TZ",
    mode: "UPI",
    status: PaymentStatus.SUCCESS,
    amountPaise: 200_000,
    paidAt: new Date("2026-04-01T00:30:00+05:30"),
    collectedBy: user._id,
    source: "CUSTOMER_APP",
  });
  await PaymentRefund.create({
    _id: createId("paymentRefund"),
    tenantId: tenant._id,
    paymentId,
    amountPaise: 20_000,
    status: GatewayRefundStatus.COMPLETED,
    completedAt: new Date("2026-04-01T00:15:00+05:30"),
  });
  const mar = await collectionSummary({
    auth: { tenantId: tenant._id, id: user._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id },
    query: { from: "2026-03-31", to: "2026-03-31" },
  });
  const apr = await collectionSummary({
    auth: { tenantId: tenant._id, id: user._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id },
    query: { from: "2026-04-01", to: "2026-04-30" },
  });
  assert.equal(mar.refundOutflowPaise, 0);
  assert.equal(apr.refundOutflowPaise, 20_000);
});
