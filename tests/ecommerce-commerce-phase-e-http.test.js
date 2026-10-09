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
  OutboxEvent,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import {
  disableEcommercePaymentsTestHarness,
  enableEcommercePaymentsTestHarness,
} from "./helpers/ecommerce-checkout-fixtures.js";
import {
  postCompletedWebhook,
  postCompletedWebhookHttp,
  postRefundWebhookHttp,
  quoteAndOrder,
  seedReady,
} from "./helpers/ecommerce-payment-test-flow.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  enableEcommercePaymentsTestHarness();
});

test("invalid PhonePe webhook auth returns 401 without mutating commerce state", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise } = await quoteAndOrder({ tenant, branch, product, customer, app });
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  assert.equal(created.status, 201);
  const merchantOrderId = created.body.data.paymentIntent.merchantOrderId;
  const beforeOrder = await EcommerceOrder.findById(orderId).lean();
  const beforeAttempt = await EcommercePaymentAttempt.findOne({ orderId }).lean();
  const beforeRefunds = await EcommercePaymentExceptionRefund.countDocuments({ orderId });

  const res = await request(app)
    .post(`/api/v1/webhooks/phonepe/${tenant._id}`)
    .set("Content-Type", "application/json")
    .set("Authorization", "Basic wrong")
    .send(
      Buffer.from(
        JSON.stringify({
          type: "CHECKOUT_ORDER_COMPLETED",
          payload: {
            originalMerchantOrderId: merchantOrderId,
            amount: totalPaise,
            paymentDetails: [{ state: "COMPLETED", transactionId: "txn-bad-auth" }],
          },
        }),
      ),
    );
  assert.equal(res.status, 401);

  const afterOrder = await EcommerceOrder.findById(orderId).lean();
  const afterAttempt = await EcommercePaymentAttempt.findOne({ orderId }).lean();
  assert.deepEqual(afterOrder.status, beforeOrder.status);
  assert.equal(afterAttempt.status, beforeAttempt.status);
  assert.equal(await EcommercePaymentExceptionRefund.countDocuments({ orderId }), beforeRefunds);
});

test("signed payment webhook via HTTP route marks order PAID once", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise } = await quoteAndOrder({ tenant, branch, product, customer, app });
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  const merchantOrderId = created.body.data.paymentIntent.merchantOrderId;
  const res = await postCompletedWebhookHttp({
    app,
    tenantId: tenant._id,
    merchantOrderId,
    amountPaise: totalPaise,
  });
  assert.equal(res.status, 200);
  const order = await EcommerceOrder.findById(orderId).lean();
  assert.equal(order.status, EcommerceOrderStatus.PAID);
});

test("plan downgrade after INITIATED blocks new intents but webhook still settles", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise } = await quoteAndOrder({ tenant, branch, product, customer, app });
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  assert.equal(created.status, 201);
  const merchantOrderId = created.body.data.paymentIntent.merchantOrderId;

  disableEcommercePaymentsTestHarness();
  const { Tenant } = await import("../src/models/index.js");
  await Tenant.updateOne(
    { _id: tenant._id },
    {
      $set: {
        "subscription.planFeaturesSnapshot.ecommercePayments": false,
        "operations.ecommercePaymentsRolloutEnabled": false,
      },
    },
  );

  const blocked = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay2") })
    .send({ redirectUrl: "https://example.com/return" });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.error?.code, "PAYMENT_NOT_AVAILABLE");

  const res = await postCompletedWebhookHttp({
    app,
    tenantId: tenant._id,
    merchantOrderId,
    amountPaise: totalPaise,
    transactionId: "txn-downgrade",
  });
  assert.equal(res.status, 200);
  const order = await EcommerceOrder.findById(orderId).lean();
  assert.equal(order.status, EcommerceOrderStatus.PAID);
});

test("signed refund webhook confirms exception refund once", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product, adminHeaders } = await seedReady({ tenant, user, branch, app });
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
  await postCompletedWebhook({
    tenantId: tenant._id,
    merchantOrderId,
    amountPaise: totalPaise,
    transactionId: "txn-late",
  });
  const init = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/payment-exception-refund/initiate`)
    .set(adminHeaders);
  assert.equal(init.status, 200);
  const providerRefundId = init.body.data.refund.providerRefundId;
  const refundCase = await EcommercePaymentExceptionRefund.findOne({ orderId }).lean();
  assert.equal(refundCase.status, EcommercePaymentExceptionRefundStatus.PROVIDER_PENDING);

  const payload = {
    originalMerchantOrderId: merchantOrderId,
    refundId: providerRefundId,
    amount: totalPaise,
    currency: "INR",
  };
  const first = await postRefundWebhookHttp({
    app,
    tenantId: tenant._id,
    type: "PG_REFUND_COMPLETED",
    payload,
  });
  assert.equal(first.res.status, 200);
  const afterFirst = await EcommercePaymentExceptionRefund.findOne({ orderId }).lean();
  assert.equal(afterFirst.status, EcommercePaymentExceptionRefundStatus.SUCCEEDED);
  const outboxCount = await OutboxEvent.countDocuments({
    tenantId: tenant._id,
    topic: "ecommerce.refund.completed",
    key: `${orderId}:${afterFirst._id}`,
  });
  assert.ok(outboxCount >= 1);

  const second = await postRefundWebhookHttp({
    app,
    tenantId: tenant._id,
    type: "PG_REFUND_COMPLETED",
    payload,
  });
  assert.equal(second.res.status, 200);
  const afterSecond = await EcommercePaymentExceptionRefund.findOne({ orderId }).lean();
  assert.equal(afterSecond.status, EcommercePaymentExceptionRefundStatus.SUCCEEDED);
  assert.equal(
    await OutboxEvent.countDocuments({
      tenantId: tenant._id,
      topic: "ecommerce.refund.completed",
      key: `${orderId}:${afterFirst._id}`,
    }),
    outboxCount,
  );
});

test("customer order API never shows refunded while provider refund pending", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product, adminHeaders } = await seedReady({ tenant, user, branch, app });
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
  await postCompletedWebhook({
    tenantId: tenant._id,
    merchantOrderId,
    amountPaise: totalPaise,
    transactionId: "txn-late-customer",
  });
  const initRes = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/payment-exception-refund/initiate`)
    .set(adminHeaders);
  assert.equal(initRes.status, 200);

  const view = await request(app)
    .get(`/api/v1/app/shop/orders/${orderId}`)
    .set({ authorization: `Bearer ${token}` });
  assert.equal(view.status, 200);
  assert.equal(view.body.data.refundStatus, "REFUND_PENDING");
  assert.notEqual(view.body.data.refundStatus, "REFUNDED");
});

test("admin reconcile retry requires reason and does not mark PAID without provider success", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product, adminHeaders } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId } = await quoteAndOrder({ tenant, branch, product, customer, app });
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  const attemptId = created.body.data.paymentIntent.id;
  await EcommercePaymentAttempt.updateOne(
    { _id: attemptId },
    {
      $set: {
        operationalStatus: "STUCK_RECONCILE",
        status: EcommercePaymentAttemptStatus.INITIATED,
      },
    },
  );
  const retry = await request(app)
    .post(
      `/api/v1/admin/ecommerce/orders/${orderId}/payment-attempts/${attemptId}/reconcile-retry`,
    )
    .set({ ...adminHeaders, "content-type": "application/json" })
    .send({ reason: "Operator verified provider still pending" });
  assert.equal(retry.status, 200);
  const order = await EcommerceOrder.findById(orderId).lean();
  assert.notEqual(order.status, EcommerceOrderStatus.PAID);
});

test("payment exceptions queue lists stuck and pending refund cases", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product, adminHeaders } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise } = await quoteAndOrder({ tenant, branch, product, customer, app });
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  await EcommercePaymentAttempt.updateOne(
    { orderId },
    { $set: { operationalStatus: "INITIATION_UNCERTAIN" } },
  );
  await EcommerceOrder.updateOne(
    { _id: orderId },
    { $set: { status: EcommerceOrderStatus.PAYMENT_EXPIRED, stockReleasedAt: new Date() } },
  );
  await postCompletedWebhook({
    tenantId: tenant._id,
    merchantOrderId: created.body.data.paymentIntent.merchantOrderId,
    amountPaise: totalPaise,
    transactionId: "txn-queue-late",
  });
  const initRes = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/payment-exception-refund/initiate`)
    .set(adminHeaders);
  assert.equal(initRes.status, 200);

  const queue = await request(app)
    .get("/api/v1/admin/ecommerce/payment-exceptions")
    .set({ authorization: adminHeaders.authorization });
  assert.equal(queue.status, 200);
  const kinds = new Set((queue.body.data.items ?? []).map((row) => row.kind));
  assert.ok(kinds.has("EXCEPTION_REFUND"));
  assert.ok(kinds.has("INITIATION_UNCERTAIN") || kinds.has("LATE_SUCCESS_REFUND_REQUIRED"));
});
