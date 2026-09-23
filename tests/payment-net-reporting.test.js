import test from "node:test";
import assert from "node:assert/strict";
import { PaymentStatus } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import {
  netAmountPaiseFromDoc,
  netWeightMgFromDoc,
} from "../src/lib/payment-net-aggregation.js";
import { Payment } from "../src/models/index.js";
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
      _id: createId("payment"),
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
      _id: createId("payment"),
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
      collectedBy: user._id,
      source: "CUSTOMER_APP",
    },
  ]);
  const req = {
    auth: { tenantId: tenant._id, id: user._id, role: user.role, type: "TENANT_USER" },
    scope: { tenantId: tenant._id },
    query: { period: "TODAY" },
  };
  const summary = await collectionSummary(req);
  const dash = await dashboard(req);
  const expectedNet = 17_500_000;
  const expectedCount = 2;
  assert.equal(summary.amountPaise, expectedNet);
  assert.equal(summary.count, expectedCount);
  assert.equal(dash.today.amountPaise, expectedNet);
  assert.equal(dash.today.count, expectedCount);
  const cashMode = summary.byMode.find((row) => row.mode === "CASH");
  const upiMode = summary.byMode.find((row) => row.mode === "UPI");
  assert.equal(cashMode.amountPaise, 7_500_000);
  assert.equal(upiMode.amountPaise, 10_000_000);
});
