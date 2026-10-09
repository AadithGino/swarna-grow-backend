import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { CallbackType } from "@phonepe-pg/pg-sdk-node";
import { createApp } from "../src/app.js";
import {
  EcommerceFulfilmentMode,
  EcommerceOrderPaymentExceptionStatus,
  EcommerceOrderStatus,
  EcommercePaymentAttemptStatus,
  EcommercePriceMode,
  EcommerceStockPolicy,
  PlanTier,
} from "../src/constants/enums.js";
import {
  EcommerceInventory,
  EcommerceOrder,
  EcommercePaymentAttempt,
  EcommercePaymentAttemptEvent,
  Session,
  Tenant,
  WebhookEvent,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import { processWebhook } from "../src/workers/processors.js";
import { configureTenantPhonePe } from "./helpers/gateway-http-fixture.js";
import {
  disableEcommercePaymentsTestHarness,
  enableEcommercePaymentsTestHarness,
  taxReadyCatalogBody,
  taxReadyFulfilmentBody,
} from "./helpers/ecommerce-checkout-fixtures.js";
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  enableEcommercePaymentsTestHarness();
});

async function enableStore(tenant) {
  await Tenant.updateOne(
    { _id: tenant._id },
    {
      $set: {
        "subscription.planFeaturesSnapshot": { ecommerce: true, ecommercePayments: true },
        "subscription.tier": PlanTier.PRO,
        "operations.ecommerceEnabled": true,
        "operations.ecommercePaymentsRolloutEnabled": true,
      },
    },
  );
  await configureTenantPhonePe(tenant._id);
}

async function customerToken({ tenant, branch, customer }) {
  const session = await Session.create({
    _id: createId("session"),
    customerId: customer._id,
    tenantId: tenant._id,
    deviceId: "dev",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "android",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const { signAccessToken } = await import("../src/services/token.service.js");
  return signAccessToken({
    id: customer._id,
    type: "CUSTOMER",
    tenantId: tenant._id,
    branchId: branch._id,
    role: "CUSTOMER",
    permissions: [],
    deviceId: "dev",
    securityVersion: 0,
    sessionId: session._id,
  });
}

async function seedReady({ tenant, user, branch, qty = 5 }) {
  await enableStore(tenant);
  await ecommerce.putTaxSettings({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: taxReadyCatalogBody(),
  });
  const adminHeaders = {
    authorization: `Bearer ${bearerFor(user)}`,
    "x-idempotency-key": createId("idem"),
  };
  await request(app)
    .put("/api/v1/admin/ecommerce/fulfilment-settings")
    .set(adminHeaders)
    .send(taxReadyFulfilmentBody(branch._id));
  const product = await ecommerce.createProduct({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: {
      name: "PayItem",
      slug: `pay-${createId("p").slice(-4)}`,
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 100_000 },
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
    .send({ stockPolicy: EcommerceStockPolicy.QUANTITY_TRACKED, quantityOnHand: qty });
  return { product, adminHeaders };
}

async function quoteAndOrder({ tenant, branch, product, customer }) {
  const token = await customerToken({ tenant, branch, customer });
  await request(app)
    .put("/api/v1/app/shop/cart")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("c") })
    .send({ lines: [{ productId: product.id, quantity: 1 }] });
  const quoteRes = await request(app)
    .post("/api/v1/app/shop/quotes")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("q") })
    .send({
      fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
      pickupBranchId: branch._id,
    });
  assert.equal(quoteRes.status, 201);
  const orderRes = await request(app)
    .post("/api/v1/app/shop/orders")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("o") })
    .send({ quoteId: quoteRes.body.data.id });
  if (orderRes.status !== 201) {
    throw new Error(JSON.stringify(orderRes.body));
  }
  return {
    token,
    orderId: orderRes.body.data.id,
    totalPaise: orderRes.body.data.totalPaise,
    productId: product.id,
  };
}

async function postCompletedWebhook({ tenantId, merchantOrderId, amountPaise, transactionId = "txn-ec-1" }) {
  const eventId = createId("webhook");
  await WebhookEvent.create({
    _id: eventId,
    tenantId,
    provider: "PHONEPE",
    providerEventId: `pe-${merchantOrderId}-${transactionId}`,
    status: "QUEUED",
    payload: {
      type: CallbackType.CHECKOUT_ORDER_COMPLETED,
      payload: {
        originalMerchantOrderId: merchantOrderId,
        amount: amountPaise,
        paymentDetails: [{ state: "COMPLETED", transactionId }],
      },
    },
  });
  await processWebhook({ data: { webhookEventId: eventId }, attemptsMade: 0 });
  return eventId;
}

test("payment intent blocked when test harness off", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  await enableStore(tenant);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { product } = await seedReady({ tenant, user, branch });
  const { token, orderId } = await quoteAndOrder({ tenant, branch, product, customer });
  disableEcommercePaymentsTestHarness();
  const res = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({
      authorization: `Bearer ${token}`,
      "x-idempotency-key": createId("pay"),
    })
    .send({ redirectUrl: "https://example.com/return" });
  assert.equal(res.status, 422);
  assert.equal(res.body.error?.code, "PAYMENT_NOT_AVAILABLE");
});

test("payment intent idempotent replay and webhook marks PAID", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise, productId } = await quoteAndOrder({
    tenant,
    branch,
    product,
    customer,
  });
  const idem = createId("pay");
  const body = { redirectUrl: "https://example.com/return" };
  const [a, b] = await Promise.all([
    request(app)
      .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
      .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem })
      .send(body),
    request(app)
      .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
      .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem })
      .send(body),
  ]);
  assert.ok([200, 201].includes(a.status));
  assert.ok([200, 201].includes(b.status));
  const attemptId = a.body.data.paymentIntent.id;
  assert.equal(a.body.data.paymentIntent.id, b.body.data.paymentIntent.id);
  const attempts = await EcommercePaymentAttempt.countDocuments({ orderId });
  assert.equal(attempts, 1);

  const merchantOrderId = a.body.data.paymentIntent.merchantOrderId;
  await postCompletedWebhook({
    tenantId: tenant._id,
    merchantOrderId,
    amountPaise: totalPaise,
  });
  const order = await EcommerceOrder.findById(orderId).lean();
  assert.equal(order.status, EcommerceOrderStatus.PAID);
  const inv = await EcommerceInventory.findOne({ tenantId: tenant._id, productId }).lean();
  assert.equal(inv.quantityOnHand, 4);

  const poll = await request(app)
    .get(`/api/v1/app/shop/orders/${orderId}/payment-intents/${attemptId}`)
    .set({ authorization: `Bearer ${token}` });
  assert.equal(poll.status, 200);
  assert.equal(poll.body.data.paymentIntent.paymentCompleted, true);
});

test("webhook amount mismatch recorded and order stays unpaid", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise } = await quoteAndOrder({ tenant, branch, product, customer });
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  const merchantOrderId = created.body.data.paymentIntent.merchantOrderId;
  await postCompletedWebhook({
    tenantId: tenant._id,
    merchantOrderId,
    amountPaise: totalPaise - 1,
  });
  const order = await EcommerceOrder.findById(orderId).lean();
  assert.equal(order.status, EcommerceOrderStatus.PENDING_PAYMENT);
  const ev = await EcommercePaymentAttemptEvent.findOne({
    tenantId: tenant._id,
    outcome: "AMOUNT_MISMATCH",
  }).lean();
  assert.ok(ev);
});

test("late success after payment expiry goes to refund exception", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise } = await quoteAndOrder({ tenant, branch, product, customer });
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
  assert.equal(
    order.paymentExceptionStatus,
    EcommerceOrderPaymentExceptionStatus.LATE_SUCCESS_REFUND_REQUIRED,
  );
});

test("duplicate completed webhook is safe", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise } = await quoteAndOrder({ tenant, branch, product, customer });
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  const merchantOrderId = created.body.data.paymentIntent.merchantOrderId;
  await postCompletedWebhook({ tenantId: tenant._id, merchantOrderId, amountPaise: totalPaise });
  await postCompletedWebhook({
    tenantId: tenant._id,
    merchantOrderId,
    amountPaise: totalPaise,
    transactionId: "txn-dup",
  });
  const order = await EcommerceOrder.findById(orderId).lean();
  assert.equal(order.status, EcommerceOrderStatus.PAID);
  const succeeded = await EcommercePaymentAttempt.countDocuments({
    orderId,
    status: EcommercePaymentAttemptStatus.SUCCEEDED,
  });
  assert.equal(succeeded, 1);
});

test("cross-customer payment intent poll returns 404", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch });
  const customerA = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const customerB = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+918800000002",
  });
  const { token: tokenA, orderId } = await quoteAndOrder({
    tenant,
    branch,
    product,
    customer: customerA,
  });
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${tokenA}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  const attemptId = created.body.data.paymentIntent.id;
  const tokenB = await customerToken({ tenant, branch, customer: customerB });
  const res = await request(app)
    .get(`/api/v1/app/shop/orders/${orderId}/payment-intents/${attemptId}`)
    .set({ authorization: `Bearer ${tokenB}` });
  assert.equal(res.status, 404);
});
