import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../src/config/env.js";
import { PaymentIntentStatus, PaymentMode, PaymentStatus } from "../src/constants/enums.js";
import { reconcileGatewayPayment } from "../src/services/phonepe-reconcile.service.js";
import { Customer, Payment, PaymentIntent, Scheme } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import {
  armMockOrderStatusTemplate,
  clearPhonePeProviderTestHooks,
} from "../src/lib/phonepe-provider-test-hooks.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  clearPhonePeProviderTestHooks();
});

async function seedGatewayFixture() {
  const { tenant, branch, user } = await seedTenantUser();
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "Gateway Customer",
    mobile: `+9188${String(Date.now()).slice(-8)}`,
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      paymentRules: { partialPaymentAllowed: true, advancePaymentAllowed: false, maxAdvanceInstallments: 0, minPaymentPaise: 1000 },
    },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installmentAmountPaise: 50_000,
    installments: [{
      number: 1,
      dueDate: "2026-01-05",
      amountPaise: 50_000,
      paidPaise: 0,
      status: "DUE",
      graceEndsAt: "2026-01-10",
    }],
    positionVersion: 1,
    version: 1,
    createdBy: user._id,
  });
  return { tenant, branch, customer, scheme };
}

async function seedPendingGatewayPayment({ mockSuffix }) {
  const { tenant, branch, customer, scheme } = await seedGatewayFixture();
  const intentId = createId("paymentIntent");
  if (mockSuffix) armMockOrderStatusTemplate(intentId, mockSuffix);
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    receiptNumber: `PENDING-${intentId}`,
    amountPaise: 50_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(Date.now() - 3600_000),
  });
  await PaymentIntent.create({
    _id: intentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    amountPaise: 50_000,
    positionVersion: 1,
    status: PaymentIntentStatus.PENDING,
    paymentId,
    version: 1,
  });
  return { paymentId, intentId };
}

test("reconcile completes pending payment without webhook", async () => {
  assert.equal(env.PROVIDER_MODE, "mock", "reconcile integration tests require PROVIDER_MODE=mock");
  const { paymentId, intentId } = await seedPendingGatewayPayment({ mockSuffix: "__mock_completed__" });
  const payment = await Payment.findById(paymentId).lean();
  const result = await reconcileGatewayPayment(payment);
  assert.equal(result.outcome, "COMPLETED");
  const afterPayment = await Payment.findById(paymentId).lean();
  assert.equal(afterPayment.status, PaymentStatus.SUCCESS);
  const afterIntent = await PaymentIntent.findById(intentId).lean();
  assert.equal(afterIntent.status, PaymentIntentStatus.SUCCEEDED);
});

test("reconcile applies terminal failure from provider status", async () => {
  assert.equal(env.PROVIDER_MODE, "mock", "reconcile integration tests require PROVIDER_MODE=mock");
  const { paymentId, intentId } = await seedPendingGatewayPayment({ mockSuffix: "__mock_failed__" });
  const payment = await Payment.findById(paymentId).lean();
  const result = await reconcileGatewayPayment(payment);
  assert.equal(result.outcome, "TERMINAL_FAILED");
  const afterPayment = await Payment.findById(paymentId).lean();
  assert.equal(afterPayment.status, PaymentStatus.FAILED);
  const afterIntent = await PaymentIntent.findById(intentId).lean();
  assert.equal(afterIntent.status, PaymentIntentStatus.FAILED);
});
