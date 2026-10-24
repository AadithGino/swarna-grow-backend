import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceOrderStatus,
  EcommercePaymentAttemptStatus,
} from "../src/constants/enums.js";
import { EcommerceInventory, EcommerceOrder } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import {
  disableEcommercePaymentsTestHarness,
  enableEcommercePaymentsTestHarness,
} from "./helpers/ecommerce-checkout-fixtures.js";
import { quoteAndOrder, seedReady } from "./helpers/ecommerce-payment-test-flow.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.describe("ecommerce payment test harness HTTP", () => {
  test.beforeEach(async () => {
    await resetTestDb();
    enableEcommercePaymentsTestHarness();
  });

  test("test-harness complete-payment returns 404 when harness disabled", async () => {
  disableEcommercePaymentsTestHarness();
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  enableEcommercePaymentsTestHarness();
  const { token, orderId } = await quoteAndOrder({ tenant, branch, product, customer, app });
  disableEcommercePaymentsTestHarness();
  const res = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/test-harness/complete-payment`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("h") })
    .send({ outcome: "COMPLETED" });
  assert.equal(res.status, 404);
});

test("test-harness COMPLETED marks order PAID and consumes stock once", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch, app, qty: 3 });
  const invBefore = await EcommerceInventory.findOne({ tenantId: tenant._id, productId: product.id }).lean();
  const beforeQty = invBefore?.quantityOnHand ?? 0;
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId } = await quoteAndOrder({ tenant, branch, product, customer, app });
  await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  const res = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/test-harness/complete-payment`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("ok") })
    .send({ outcome: "COMPLETED" });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.orderStatus, EcommerceOrderStatus.PAID);
  const order = await EcommerceOrder.findById(orderId).lean();
  assert.equal(order.status, EcommerceOrderStatus.PAID);
  const invAfter = await EcommerceInventory.findOne({ tenantId: tenant._id, productId: product.id }).lean();
  assert.equal(invAfter?.quantityOnHand, beforeQty - 1);
});

test("test-harness FAILED then COMPLETED retry pays order", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId } = await quoteAndOrder({ tenant, branch, product, customer, app });
  await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  const fail = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/test-harness/complete-payment`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("fail") })
    .send({ outcome: "FAILED" });
  assert.equal(fail.status, 200);
  assert.equal(fail.body.data.paymentAttemptStatus, EcommercePaymentAttemptStatus.FAILED);
  const orderAfterFail = await EcommerceOrder.findById(orderId).lean();
  assert.equal(orderAfterFail.status, EcommerceOrderStatus.PENDING_PAYMENT);
  await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay2") })
    .send({ redirectUrl: "https://example.com/return" });
  const ok = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/test-harness/complete-payment`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("ok2") })
    .send({ outcome: "COMPLETED" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.orderStatus, EcommerceOrderStatus.PAID);
});

test("test-harness unavailable on PAYMENT_EXPIRED order", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId } = await quoteAndOrder({ tenant, branch, product, customer, app });
  await EcommerceOrder.updateOne(
    { _id: orderId },
    { $set: { status: EcommerceOrderStatus.PAYMENT_EXPIRED, stockReleasedAt: new Date() } },
  );
  const res = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/test-harness/complete-payment`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("exp") })
    .send({ outcome: "COMPLETED" });
  assert.equal(res.status, 422);
  assert.equal(res.body.error?.code, "ORDER_NOT_PAYABLE");
});
});
