import test from "node:test";
import assert from "node:assert/strict";
import { createId } from "../src/lib/ids.js";
import { Payment, Scheme } from "../src/models/index.js";
import {
  PaymentPattern,
  PaymentMode,
  PaymentStatus,
  PaymentSource,
  SchemeStatus,
  TenantRole,
  ValueBasis,
} from "../src/constants/enums.js";
import { adminStaffBalanceDetail, cashBalance } from "../src/services/cash.service.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("staff balance detail lists partial and reversed cash rows with net total matching balance", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.BRANCH_STAFF });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const schemeId = createId("scheme");
  await Scheme.create({
    _id: schemeId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("plan"),
    enrollmentNumber: "CASH-DET-1",
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
      receiptNumber: "C-OK",
      amountPaise: 100_000,
      status: PaymentStatus.SUCCESS,
      mode: PaymentMode.CASH,
      source: PaymentSource.PORTAL,
      collectedBy: user._id,
      paidAt: new Date("2026-09-01"),
    },
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId,
      customerId: customer._id,
      receiptNumber: "C-PART",
      amountPaise: 80_000,
      refundedAmountPaise: 20_000,
      status: PaymentStatus.PARTIALLY_REFUNDED,
      mode: PaymentMode.CASH,
      source: PaymentSource.PORTAL,
      collectedBy: user._id,
      paidAt: new Date("2026-09-02"),
    },
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId,
      customerId: customer._id,
      receiptNumber: "C-REV",
      amountPaise: 50_000,
      refundedAmountPaise: 50_000,
      status: PaymentStatus.REVERSED,
      mode: PaymentMode.CASH,
      source: PaymentSource.PORTAL,
      collectedBy: user._id,
      paidAt: new Date("2026-09-03"),
    },
  ]);

  const balance = await cashBalance({
    tenantId: tenant._id,
    branchId: branch._id,
    staffId: user._id,
  });
  const detail = await adminStaffBalanceDetail({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER", role: TenantRole.BRANCH_MANAGER },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { staffId: user._id },
  });

  assert.equal(detail.collections.length, 3);
  const partial = detail.collections.find((row) => row.receiptNumber === "C-PART");
  assert.equal(partial.grossAmount.amountPaise, 80_000);
  assert.equal(partial.refundedAmount.amountPaise, 20_000);
  assert.equal(partial.netAmount.amountPaise, 60_000);
  const reversed = detail.collections.find((row) => row.receiptNumber === "C-REV");
  assert.equal(reversed.grossAmount.amountPaise, 50_000);
  assert.equal(reversed.netAmount.amountPaise, 0);
  assert.equal(detail.collectionsNetTotal.amountPaise, balance.cashCollectedPaise);
  assert.equal(detail.collectionsNetTotal.amountPaise, 160_000);
});
