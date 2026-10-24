import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceOrderStatus,
  EcommercePaymentAttemptStatus,
  EcommercePaymentExceptionRefundStatus,
} from "../src/constants/enums.js";
import {
  EcommerceOrder,
  EcommercePaymentAttempt,
  EcommercePaymentExceptionRefund,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { finalizeEcommercePaymentSuccess } from "../src/services/ecommerce-payment-finalize.service.js";
import { reconcileEcommercePaymentAttempt } from "../src/services/ecommerce-payment-reconcile.service.js";
import {
  disableEcommercePaymentsTestHarness,
  enableEcommercePaymentsTestHarness,
} from "./helpers/ecommerce-checkout-fixtures.js";
import {
  postCompletedWebhook,
  quoteAndOrder,
  seedReady,
} from "./helpers/ecommerce-payment-test-flow.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.describe("commerce phase D2 hardening HTTP", () => {
  test.beforeEach(async () => {
    await resetTestDb();
    enableEcommercePaymentsTestHarness();
  });

  test("second payment intent with different idempotency key is rejected", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId } = await quoteAndOrder({ tenant, branch, product, customer, app });
  const first = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  assert.equal(first.status, 201);
  const second = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay2") })
    .send({ redirectUrl: "https://example.com/return" });
  assert.equal(second.status, 422);
  assert.equal(second.body.error?.code, "PAYMENT_ATTEMPT_IN_PROGRESS");
});

test("webhook and reconcile racing still yield one PAID order", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise } = await quoteAndOrder({ tenant, branch, product, customer, app });
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  const merchantOrderId = created.body.data.paymentIntent.merchantOrderId;
  const attempt = await EcommercePaymentAttempt.findOne({ orderId }).lean();
  await Promise.all([
    postCompletedWebhook({ tenantId: tenant._id, merchantOrderId, amountPaise: totalPaise }),
    reconcileEcommercePaymentAttempt(attempt, { leaseOwner: "test-lease" }),
    finalizeEcommercePaymentSuccess({
      tenantId: tenant._id,
      merchantOrderId,
      transactionId: "txn-race",
      amountPaise: totalPaise,
      currency: "INR",
      providerPayload: {},
      source: "TEST",
    }),
  ]);
  const order = await EcommerceOrder.findById(orderId).lean();
  assert.equal(order.status, EcommerceOrderStatus.PAID);
  assert.equal(
    await EcommercePaymentAttempt.countDocuments({
      orderId,
      status: EcommercePaymentAttemptStatus.SUCCEEDED,
    }),
    1,
  );
});

test("late success after stock release creates refund case and never PAID", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise } = await quoteAndOrder({ tenant, branch, product, customer, app });
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  const merchantOrderId = created.body.data.paymentIntent.merchantOrderId;
  await EcommerceOrder.updateOne(
    { _id: orderId },
    { $set: { status: EcommerceOrderStatus.PAYMENT_EXPIRED, stockReleasedAt: new Date() } },
  );
  await postCompletedWebhook({ tenantId: tenant._id, merchantOrderId, amountPaise: totalPaise });
  const order = await EcommerceOrder.findById(orderId).lean();
  assert.equal(order.status, EcommerceOrderStatus.PAYMENT_EXPIRED);
  const refund = await EcommercePaymentExceptionRefund.findOne({ orderId }).lean();
  assert.ok(refund);
  assert.equal(refund.status, EcommercePaymentExceptionRefundStatus.ASSIGNED);
});

test("payment intent blocked when harness disabled after order exists", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId } = await quoteAndOrder({ tenant, branch, product, customer, app });
  disableEcommercePaymentsTestHarness();
  const pay = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  assert.equal(pay.status, 422);
  assert.equal(pay.body.error?.code, "PAYMENT_NOT_AVAILABLE");
});
});
