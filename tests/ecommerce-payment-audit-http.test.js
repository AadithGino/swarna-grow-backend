import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceOrderPaymentExceptionStatus,
  EcommerceOrderStatus,
  EcommercePaymentAttemptStatus,
  EcommercePaymentExceptionRefundStatus,
  EcommercePriceMode,
  EcommerceStockPolicy,
} from "../src/constants/enums.js";
import { Permission } from "../src/constants/permissions.js";
import {
  EcommerceOrder,
  EcommercePaymentAttempt,
  EcommercePaymentExceptionRefund,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { finalizeEcommercePaymentSuccess } from "../src/services/ecommerce-payment-finalize.service.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import {
  postCompletedWebhook,
  quoteAndOrder,
  seedReady,
} from "./helpers/ecommerce-payment-test-flow.js";
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { enableEcommercePaymentsTestHarness } from "./helpers/ecommerce-checkout-fixtures.js";

const app = createApp();

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.describe("ecommerce payment audit HTTP", () => {
  test.beforeEach(async () => {
    await resetTestDb();
    enableEcommercePaymentsTestHarness();
  });

  test("payment idempotency key cannot be reused across different orders", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const first = await quoteAndOrder({ tenant, branch, product, customer, app });
  const second = await quoteAndOrder({ tenant, branch, product, customer, app });
  const sharedKey = createId("pay-shared");
  const ok = await request(app)
    .post(`/api/v1/app/shop/orders/${first.orderId}/payment-intents`)
    .set({ authorization: `Bearer ${first.token}`, "x-idempotency-key": sharedKey })
    .send({ redirectUrl: "https://example.com/return" });
  assert.equal(ok.status, 201);
  const conflict = await request(app)
    .post(`/api/v1/app/shop/orders/${second.orderId}/payment-intents`)
    .set({ authorization: `Bearer ${second.token}`, "x-idempotency-key": sharedKey })
    .send({ redirectUrl: "https://example.com/return" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error?.code, "IDEMPOTENCY_KEY_REUSED");
});

test("made-to-order-only cart passes payment boundary", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { adminHeaders } = await seedReady({ tenant, user, branch, app });
  const product = await ecommerce.createProduct({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: {
      name: "MTO Item",
      slug: `mto-${createId("p").slice(-4)}`,
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 50_000 },
      taxClassification: "GST_3",
    },
  });
  await ecommerce.publishProduct({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    params: { productId: product.id },
    body: { expectedVersion: 1 },
  });
  await request(app)
    .patch(`/api/v1/admin/ecommerce/inventory/${product.id}`)
    .set(adminHeaders)
    .send({ stockPolicy: EcommerceStockPolicy.MADE_TO_ORDER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId } = await quoteAndOrder({
    tenant,
    branch,
    product,
    customer,
    app,
  });
  const pay = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  assert.equal(pay.status, 201);
});

test("second success on already PAID order creates duplicate refund exception", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise } = await quoteAndOrder({ tenant, branch, product, customer, app });
  const firstKey = createId("pay1");
  const first = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": firstKey })
    .send({ redirectUrl: "https://example.com/return" });
  assert.equal(first.status, 201);
  await postCompletedWebhook({
    tenantId: tenant._id,
    merchantOrderId: first.body.data.paymentIntent.merchantOrderId,
    amountPaise: totalPaise,
    transactionId: "txn-first",
  });
  const paid = await EcommerceOrder.findById(orderId).lean();
  assert.equal(paid.status, EcommerceOrderStatus.PAID);

  const secondAttemptId = createId("epay");
  await EcommercePaymentAttempt.create({
    _id: secondAttemptId,
    tenantId: tenant._id,
    orderId,
    customerId: customer._id,
    status: EcommercePaymentAttemptStatus.INITIATED,
    amountPaise: totalPaise,
    currency: "INR",
    provider: "PHONEPE",
    merchantOrderId: secondAttemptId,
    idempotencyKey: createId("pay2"),
    redirectUrl: "https://example.com/return",
  });
  const dup = await finalizeEcommercePaymentSuccess({
    tenantId: tenant._id,
    merchantOrderId: secondAttemptId,
    transactionId: "txn-dup",
    amountPaise: totalPaise,
    currency: "INR",
    providerPayload: {},
    source: "TEST",
  });
  assert.equal(dup.outcome, "DUPLICATE_PAYMENT_EXCEPTION");
  const order = await EcommerceOrder.findById(orderId).lean();
  assert.equal(order.status, EcommerceOrderStatus.PAID);
  assert.equal(
    order.paymentExceptionStatus,
    EcommerceOrderPaymentExceptionStatus.DUPLICATE_PAYMENT_REFUND_REQUIRED,
  );
  const refund = await EcommercePaymentExceptionRefund.findOne({ orderId }).lean();
  assert.ok(refund);
  assert.equal(refund.paymentAttemptId, secondAttemptId);
});

test("concurrent refund initiations reuse stable merchant refund id", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product, adminHeaders } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise } = await quoteAndOrder({ tenant, branch, product, customer, app });
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  await EcommerceOrder.updateOne(
    { _id: orderId },
    { $set: { status: EcommerceOrderStatus.PAYMENT_EXPIRED, stockReleasedAt: new Date() } },
  );
  await postCompletedWebhook({
    tenantId: tenant._id,
    merchantOrderId: created.body.data.paymentIntent.merchantOrderId,
    amountPaise: totalPaise,
    transactionId: "txn-late-ref",
  });
  const refundBefore = await EcommercePaymentExceptionRefund.findOne({ orderId }).lean();
  assert.ok(refundBefore);
  const [a, b] = await Promise.all([
    request(app)
      .post(`/api/v1/admin/ecommerce/orders/${orderId}/payment-exception-refund/initiate`)
      .set(adminHeaders),
    request(app)
      .post(`/api/v1/admin/ecommerce/orders/${orderId}/payment-exception-refund/initiate`)
      .set(adminHeaders),
  ]);
  assert.ok([200, 409, 422].includes(a.status));
  assert.ok([200, 409, 422].includes(b.status));
  const refundAfter = await EcommercePaymentExceptionRefund.findOne({ orderId }).lean();
  assert.equal(refundAfter._id, refundBefore._id);
  assert.equal(refundAfter.providerRefundId, refundBefore._id);
  assert.notEqual(refundAfter.status, EcommercePaymentExceptionRefundStatus.SUCCEEDED);
});

test("catalog write permission cannot initiate exception refunds", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise } = await quoteAndOrder({ tenant, branch, product, customer, app });
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  await EcommerceOrder.updateOne(
    { _id: orderId },
    { $set: { status: EcommerceOrderStatus.PAYMENT_EXPIRED, stockReleasedAt: new Date() } },
  );
  await postCompletedWebhook({
    tenantId: tenant._id,
    merchantOrderId: created.body.data.paymentIntent.merchantOrderId,
    amountPaise: totalPaise,
  });
  const catalogOnly = bearerFor(user, [Permission.ECOMMERCE_READ, Permission.ECOMMERCE_WRITE]);
  const denied = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/payment-exception-refund/initiate`)
    .set({ authorization: `Bearer ${catalogOnly}` });
  assert.equal(denied.status, 403);
});

test("GET order exposes active payment attempt for resume", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId } = await quoteAndOrder({ tenant, branch, product, customer, app });
  const idem = createId("pay-resume");
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem })
    .send({ redirectUrl: "https://example.com/return" });
  assert.equal(created.status, 201);
  const view = await request(app)
    .get(`/api/v1/app/shop/orders/${orderId}`)
    .set({ authorization: `Bearer ${token}` });
  assert.equal(view.status, 200);
  assert.equal(view.body.data.activePaymentAttempt?.id, created.body.data.paymentIntent.id);
  assert.equal(view.body.data.activePaymentAttempt?.idempotencyKey, idem);
});
});
