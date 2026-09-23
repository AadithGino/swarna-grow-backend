import test from "node:test";
import assert from "node:assert/strict";
import { createId } from "../src/lib/ids.js";
import { Payment, Scheme } from "../src/models/index.js";
import {
  PaymentPattern,
  PaymentStatus,
  SchemeStatus,
  ValueBasis,
} from "../src/constants/enums.js";
import { buildHome, listPaymentsForApp } from "../src/services/customer-app.service.js";
import { mapCustomerPaymentListItem } from "../src/lib/customer-scheme-detail-dto.js";
import { Tenant } from "../src/models/index.js";
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

async function seedScheme(tenant, branch, customerId) {
  return Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    planId: createId("plan"),
    enrollmentNumber: "ENR-PAY-1",
    planSnapshot: { name: "Plan" },
    valueBasis: ValueBasis.CASH,
    paymentPattern: PaymentPattern.FIXED,
    status: SchemeStatus.ACTIVE,
    startDate: "2026-01-01",
    maturityDate: "2026-12-31",
    installments: [],
  });
}

test("25% partial refund exposes gross refunded net on recent and passbook rows", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await seedScheme(tenant, branch, customer._id);
  await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    receiptNumber: "R-PARTIAL",
    amountPaise: 100_000,
    refundedAmountPaise: 25_000,
    status: PaymentStatus.PARTIALLY_REFUNDED,
    mode: "CASH",
    source: "CUSTOMER_APP",
    paidAt: new Date("2026-09-02T10:00:00+05:30"),
    allocatedAmountPaise: 100_000,
  });

  const auth = { id: customer._id, tenantId: tenant._id, branchId: branch._id };
  const tenantDoc = await Tenant.findById(tenant._id).lean();
  const home = await buildHome(auth, tenantDoc, {});
  assert.equal(home.recentPayments.length, 1);
  assert.equal(home.recentPayments[0].grossAmount.amountPaise, 100_000);
  assert.equal(home.recentPayments[0].refundedAmount.amountPaise, 25_000);
  assert.equal(home.recentPayments[0].netAmount.amountPaise, 75_000);
  assert.equal(home.recentPayments[0].amount.amountPaise, 75_000);

  const passbook = await listPaymentsForApp({
    auth,
    query: {},
  });
  assert.equal(passbook.data[0].netAmountPaise, 75_000);
  assert.equal(passbook.meta.summary.totalPaidPaise, 75_000);
});

test("fully reversed payment excluded from recent positive activity", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await seedScheme(tenant, branch, customer._id);
  await Payment.create([
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId: customer._id,
      receiptNumber: "R-REV",
      amountPaise: 50_000,
      refundedAmountPaise: 50_000,
      status: PaymentStatus.REVERSED,
      mode: "CASH",
      source: "CUSTOMER_APP",
      paidAt: new Date("2026-09-03T10:00:00+05:30"),
    },
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId: customer._id,
      receiptNumber: "R-OK",
      amountPaise: 30_000,
      status: PaymentStatus.SUCCESS,
      mode: "CASH",
      source: "CUSTOMER_APP",
      paidAt: new Date("2026-09-02T10:00:00+05:30"),
      allocatedAmountPaise: 30_000,
    },
  ]);

  const auth = { id: customer._id, tenantId: tenant._id, branchId: branch._id };
  const tenantDoc = await Tenant.findById(tenant._id).lean();
  const home = await buildHome(auth, tenantDoc, {});
  assert.equal(home.recentPayments.length, 1);
  assert.equal(home.recentPayments[0].receiptNumber, "R-OK");
  const homeNet = home.recentPayments.reduce((s, p) => s + p.amount.amountPaise, 0);
  assert.equal(homeNet, 30_000);
});

test("gold partial refund includes net weight fields on scheme detail payment row", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("plan"),
    enrollmentNumber: "GOLD-PAY",
    planSnapshot: { name: "Gold" },
    valueBasis: ValueBasis.GOLD_WEIGHT,
    paymentPattern: PaymentPattern.FIXED,
    status: SchemeStatus.ACTIVE,
    startDate: "2026-01-01",
    maturityDate: "2026-12-31",
    installments: [],
  });
  const payment = await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    receiptNumber: "R-GOLD",
    amountPaise: 100_000,
    weightMg: 200,
    refundedAmountPaise: 25_000,
    refundedWeightMg: 50,
    status: PaymentStatus.PARTIALLY_REFUNDED,
    mode: "CASH",
    source: "CUSTOMER_APP",
    paidAt: new Date(),
    allocatedAmountPaise: 100_000,
  });

  const row = mapCustomerPaymentListItem(payment.toObject(), scheme.toObject());
  assert.equal(row.netAmountPaise, 75_000);
  assert.equal(row.grossAmountPaise, 100_000);
  assert.equal(row.refundedAmountPaise, 25_000);
  assert.equal(row.goldAccrual.weightMg, 150);
  assert.equal(row.goldAccrual.grossGoldAccrual.weightMg, 200);
});
