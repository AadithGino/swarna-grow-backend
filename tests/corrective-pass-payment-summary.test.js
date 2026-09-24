import test from "node:test";
import assert from "node:assert/strict";
import { createId } from "../src/lib/ids.js";
import { Payment, Scheme } from "../src/models/index.js";
import {
  PaymentPattern,
  PaymentStatus,
  SchemeStatus,
  TenantRole,
  ValueBasis,
} from "../src/constants/enums.js";
import { listPayments } from "../src/services/payment.service.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

test("payment list summary separates collected net, gross reversed, and pending/failed", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const schemeId = createId("scheme");
  await Scheme.create({
    _id: schemeId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("plan"),
    enrollmentNumber: "SUMMARY-MIX",
    planSnapshot: {},
    valueBasis: ValueBasis.CASH,
    paymentPattern: PaymentPattern.FIXED,
    status: SchemeStatus.ACTIVE,
    startDate: "2026-01-01",
    maturityDate: "2026-12-31",
    installments: [],
  });
  await Payment.insertMany([
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId,
      customerId: customer._id,
      receiptNumber: "R-SUCCESS",
      amountPaise: 100_000,
      status: PaymentStatus.SUCCESS,
      mode: "CASH",
      source: "PORTAL",
      paidAt: new Date("2026-09-01"),
    },
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId,
      customerId: customer._id,
      receiptNumber: "R-PARTIAL",
      amountPaise: 80_000,
      refundedAmountPaise: 20_000,
      status: PaymentStatus.PARTIALLY_REFUNDED,
      mode: "CASH",
      source: "PORTAL",
      paidAt: new Date("2026-09-02"),
    },
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId,
      customerId: customer._id,
      receiptNumber: "R-REVERSED",
      amountPaise: 50_000,
      refundedAmountPaise: 50_000,
      status: PaymentStatus.REVERSED,
      mode: "CASH",
      source: "PORTAL",
      paidAt: new Date("2026-09-03"),
    },
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId,
      customerId: customer._id,
      receiptNumber: "R-PENDING",
      amountPaise: 10_000,
      status: PaymentStatus.PENDING,
      mode: "CASH",
      source: "PORTAL",
    },
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId,
      customerId: customer._id,
      receiptNumber: "R-FAILED",
      amountPaise: 5_000,
      status: PaymentStatus.FAILED,
      mode: "CASH",
      source: "PORTAL",
    },
  ]);

  const result = await listPayments({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER", role: TenantRole.TENANT_OWNER },
    scope: { tenantId: tenant._id },
    query: { includeSummary: "true" },
  });
  const summary = result.meta.summary;
  assert.equal(summary.netCollectedAmount.amountPaise, 160_000);
  assert.equal(summary.totalNetAmount.amountPaise, 160_000);
  assert.equal(summary.grossSuccessfulAmount.amountPaise, 180_000);
  assert.equal(summary.refundedAmount.amountPaise, 20_000);
  assert.equal(summary.totalRefundedAmount.amountPaise, 70_000);
  assert.equal(summary.fullyReversedAmount.amountPaise, 50_000);
  assert.equal(summary.reversedAmount.amountPaise, 50_000);
  assert.equal(summary.pendingAmount.amountPaise, 10_000);
  assert.equal(summary.failedAmount.amountPaise, 5_000);
});
