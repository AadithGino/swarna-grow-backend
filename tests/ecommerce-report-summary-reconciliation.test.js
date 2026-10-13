import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceCourierCodCollectionStatus,
  EcommerceCourierCodRemittanceStatus,
  EcommerceOrderStatus,
  EcommercePaymentExceptionRefundStatus,
  EcommercePaymentMethod,
} from "../src/constants/enums.js";
import { computeEcommerceCollections } from "../src/lib/ecommerce-workspace-collections.js";
import { createId } from "../src/lib/ids.js";
import {
  EcommerceOrder,
  EcommerceOrderCancellationRequest,
  EcommerceOrderReturnRequest,
  EcommercePaymentExceptionRefund,
} from "../src/models/index.js";
import { bearerFor, resetTestDb, seedFixture, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();
const FROM = "2026-03-01";
const TO = "2026-03-31";
const IN_PERIOD = new Date("2026-03-15T12:00:00+05:30");
const OUT_PERIOD = new Date("2026-02-10T12:00:00+05:30");

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

function reportQuery() {
  return { period: "CUSTOM", from: FROM, to: TO };
}

async function fetchSummary(user) {
  const res = await request(app)
    .get("/api/v1/admin/ecommerce/summary")
    .query(reportQuery())
    .set("authorization", `Bearer ${bearerFor(user)}`);
  assert.equal(res.status, 200);
  return res.body.data.collections;
}

async function fetchSalesReport(user) {
  const res = await request(app)
    .get("/api/v1/admin/ecommerce/reports/ECOMMERCE_SALES")
    .query(reportQuery())
    .set("authorization", `Bearer ${bearerFor(user)}`);
  assert.equal(res.status, 200);
  return res.body.data;
}

function summaryPaise(report, key) {
  const item = (report.summary ?? []).find((row) => row.key === key);
  const v = item?.value;
  return v?.amountPaise ?? v?.amount?.amountPaise ?? 0;
}

test("sales report totals match workspace summary — online payment", async () => {
  const { tenant, user, customer } = await seedFixture();
  await EcommerceOrder.create({
    _id: createId("eord"),
    tenantId: tenant._id,
    customerId: customer._id,
    orderNumber: "EC-ONLINE-1",
    status: EcommerceOrderStatus.PAID,
    paymentMethod: EcommercePaymentMethod.ONLINE,
    paidAt: IN_PERIOD,
    totalPaise: 50_000,
    subtotalPaise: 48_000,
    taxPaise: 2_000,
    fulfilmentChargePaise: 0,
    lines: [],
    version: 1,
    createdAt: IN_PERIOD,
  });

  const summary = await fetchSummary(user);
  const report = await fetchSalesReport(user);
  assert.equal(summary.onlineCollected.amountPaise, 50_000);
  assert.equal(summaryPaise(report, "ONLINE_COLLECTED"), 50_000);
  assert.equal(summary.netCollected.amountPaise, 50_000);
  assert.equal(summaryPaise(report, "NET_COLLECTED"), 50_000);
  assert.ok(Array.isArray(report.summary) && report.summary.length >= 5);
  assert.ok(report.charts?.collectionsTrend?.series?.length >= 3);
});

test("sales report totals match workspace summary — COD courier vs bank", async () => {
  const { tenant, user, customer } = await seedFixture();
  await EcommerceOrder.create({
    _id: createId("eord"),
    tenantId: tenant._id,
    customerId: customer._id,
    orderNumber: "EC-COD-1",
    status: EcommerceOrderStatus.DELIVERED,
    paymentMethod: EcommercePaymentMethod.COD,
    totalPaise: 30_000,
    courierCod: {
      collectionStatus: "CONFIRMED",
      collectionConfirmedAt: IN_PERIOD,
      expectedAmountPaise: 30_000,
      remittanceStatus: "BANK_RECONCILED",
      remittanceGrossPaise: 30_000,
      remittanceFeePaise: 500,
      remittanceNetPaise: 29_500,
      bankCreditedAt: IN_PERIOD,
    },
    lines: [],
    version: 1,
    createdAt: IN_PERIOD,
  });

  const summary = await fetchSummary(user);
  const report = await fetchSalesReport(user);
  assert.equal(summary.codCollected.amountPaise, 30_000);
  assert.equal(summary.codBankRemittanceGross.amountPaise, 30_000);
  assert.equal(summary.codBankRemittanceFees.amountPaise, 500);
  assert.equal(summary.codBankRemittanceReconciled.amountPaise, 29_500);
  assert.equal(summaryPaise(report, "COD_COURIER_COLLECTION_CONFIRMED"), 30_000);
  assert.equal(summaryPaise(report, "COD_BANK_REMITTANCE_RECONCILED"), 29_500);
  assert.equal(summary.netCollected.amountPaise, 29_500);
});

test("courier confirmed without bank does not inflate net collections", async () => {
  const { tenant, user, customer } = await seedFixture();
  await EcommerceOrder.create({
    _id: createId("eord"),
    tenantId: tenant._id,
    customerId: customer._id,
    orderNumber: "EC-COD-OWED",
    status: EcommerceOrderStatus.DELIVERED,
    paymentMethod: EcommercePaymentMethod.COD,
    totalPaise: 20_000,
    courierCod: {
      collectionStatus: EcommerceCourierCodCollectionStatus.CONFIRMED,
      collectionConfirmedAt: IN_PERIOD,
      remittanceStatus: EcommerceCourierCodRemittanceStatus.OWED,
    },
    lines: [],
    version: 1,
  });
  await EcommerceOrder.create({
    _id: createId("eord"),
    tenantId: tenant._id,
    customerId: customer._id,
    orderNumber: "EC-COUR-BANK",
    status: EcommerceOrderStatus.DELIVERED,
    paymentMethod: EcommercePaymentMethod.COD,
    totalPaise: 40_000,
    courierCod: {
      collectionStatus: EcommerceCourierCodCollectionStatus.CONFIRMED,
      collectionConfirmedAt: IN_PERIOD,
      remittanceStatus: EcommerceCourierCodRemittanceStatus.BANK_RECONCILED,
      remittanceNetPaise: 39_000,
      bankCreditedAt: IN_PERIOD,
    },
    lines: [],
    version: 1,
  });

  const metrics = await computeEcommerceCollections(tenant._id, FROM, TO);
  assert.equal(metrics.codCourierCollectionConfirmedPaise, 60_000);
  assert.equal(metrics.codBankRemittanceReconciledPaise, 39_000);
  assert.equal(metrics.grossCollectedPaise, 39_000);

  const summary = await fetchSummary(user);
  assert.equal(summary.codCollected.amountPaise, 60_000);
  assert.equal(summary.netCollected.amountPaise, 39_000);
});

test("provider refund and manual refunds reconcile once", async () => {
  const { tenant, user, customer } = await seedFixture();
  const orderId = createId("eord");
  await EcommerceOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customer._id,
    orderNumber: "EC-REF-1",
    status: EcommerceOrderStatus.PAID,
    paymentMethod: EcommercePaymentMethod.ONLINE,
    paidAt: IN_PERIOD,
    totalPaise: 100_000,
    lines: [],
    version: 1,
    createdAt: IN_PERIOD,
  });
  await EcommercePaymentExceptionRefund.create({
    _id: createId("epayref"),
    tenantId: tenant._id,
    orderId,
    paymentAttemptId: createId("epay"),
    amountPaise: 10_000,
    status: EcommercePaymentExceptionRefundStatus.SUCCEEDED,
    createdAt: IN_PERIOD,
    updatedAt: IN_PERIOD,
    version: 1,
  });

  const cancelOrderId = createId("eord");
  await EcommerceOrder.create({
    _id: cancelOrderId,
    tenantId: tenant._id,
    customerId: customer._id,
    orderNumber: "EC-COD-CAN",
    status: EcommerceOrderStatus.CANCELLED,
    paymentMethod: EcommercePaymentMethod.COD,
    totalPaise: 20_000,
    lines: [],
    version: 1,
    createdAt: IN_PERIOD,
  });
  await EcommerceOrderCancellationRequest.create({
    _id: createId("ecan"),
    tenantId: tenant._id,
    orderId: cancelOrderId,
    customerId: customer._id,
    kind: "CUSTOMER_REQUEST",
    reason: "Test cancellation refund reconciliation",
    status: "COMPLETED",
    codManualRefund: {
      amountPaise: 5_000,
      recordedAt: IN_PERIOD,
    },
    version: 1,
  });

  const returnOrderId = createId("eord");
  await EcommerceOrder.create({
    _id: returnOrderId,
    tenantId: tenant._id,
    customerId: customer._id,
    orderNumber: "EC-RET",
    status: EcommerceOrderStatus.DELIVERED,
    paymentMethod: EcommercePaymentMethod.ONLINE,
    paidAt: OUT_PERIOD,
    totalPaise: 40_000,
    lines: [],
    version: 1,
    createdAt: OUT_PERIOD,
  });
  await EcommerceOrderReturnRequest.create({
    _id: createId("eret"),
    tenantId: tenant._id,
    orderId: returnOrderId,
    customerId: customer._id,
    kind: "RETURN",
    reason: "Test return manual refund reconciliation",
    status: "RESOLVED",
    manualRefundRecordedAt: IN_PERIOD,
    manualRefundProof: { amountPaise: 3_000 },
    version: 1,
  });

  const summary = await fetchSummary(user);
  const report = await fetchSalesReport(user);
  assert.equal(summary.refundOutflow.amountPaise, 18_000);
  assert.equal(summaryPaise(report, "REFUND_OUTFLOW"), 18_000);
  assert.equal(summary.netCollected.amountPaise, 100_000 - 18_000);
});

test("refund in period for order placed earlier reduces net without placement count", async () => {
  const { tenant, user, customer } = await seedFixture();
  const orderId = createId("eord");
  await EcommerceOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customer._id,
    orderNumber: "EC-OLD",
    status: EcommerceOrderStatus.PAID,
    paymentMethod: EcommercePaymentMethod.ONLINE,
    paidAt: OUT_PERIOD,
    totalPaise: 25_000,
    lines: [],
    version: 1,
    createdAt: OUT_PERIOD,
  });
  await EcommercePaymentExceptionRefund.create({
    _id: createId("epayref"),
    tenantId: tenant._id,
    orderId,
    paymentAttemptId: createId("epay"),
    amountPaise: 25_000,
    status: EcommercePaymentExceptionRefundStatus.SUCCEEDED,
    createdAt: IN_PERIOD,
    updatedAt: IN_PERIOD,
    version: 1,
  });

  const summary = await fetchSummary(user);
  assert.equal(summary.grossCollected.amountPaise, 0);
  assert.equal(summary.refundOutflow.amountPaise, 25_000);
  assert.equal(summary.netCollected.amountPaise, -25_000);
});

test("empty tenant and cross-tenant isolation", async () => {
  const a = await seedFixture();
  const b = await seedFixture();
  await EcommerceOrder.create({
    _id: createId("eord"),
    tenantId: a.tenant._id,
    customerId: a.customer._id,
    orderNumber: "EC-A",
    status: EcommerceOrderStatus.PAID,
    paymentMethod: EcommercePaymentMethod.ONLINE,
    paidAt: IN_PERIOD,
    totalPaise: 1_000,
    lines: [],
    version: 1,
    createdAt: IN_PERIOD,
  });

  const empty = await fetchSummary(b.user);
  assert.equal(empty.grossCollected.amountPaise, 0);

  const isolated = await fetchSalesReport(b.user);
  assert.equal(summaryPaise(isolated, "GROSS_COLLECTED"), 0);
  assert.equal(summaryPaise(isolated, "GROSS_COLLECTED"), 0);
});
