import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceFulfilmentMode,
  EcommerceOrderStatus,
  EcommercePriceMode,
  EcommerceStockPolicy,
  EcommerceStockReleaseReason,
  PlanTier,
} from "../src/constants/enums.js";
import {
  EcommerceOrder,
  EcommerceStockReservation,
  Session,
  Tenant,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import { runEcommerceOrderPaymentExpiry } from "../src/services/ecommerce-order-payment-expiry.service.js";
import { schedulerRepeatableJobs } from "../src/schedulers/repeatable-jobs.js";
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
test.beforeEach(async () => { await resetTestDb(); });

async function enableStore(tenant) {
  await Tenant.updateOne(
    { _id: tenant._id },
    {
      $set: {
        "subscription.planFeaturesSnapshot": { ecommerce: true },
        "subscription.tier": PlanTier.PRO,
        "operations.ecommerceEnabled": true,
      },
    },
  );
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
    .send({ ...taxReadyFulfilmentBody(branch._id), pendingPaymentWindowMinutes: 15 });
  const product = await ecommerce.createProduct({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: {
      name: "Item",
      slug: `item-${createId("p").slice(-4)}`,
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
  enableEcommercePaymentsTestHarness();
  const orderRes = await request(app)
    .post("/api/v1/app/shop/orders")
    .set({
      authorization: `Bearer ${token}`,
      "x-idempotency-key": createId("o"),
    })
    .send({ quoteId: quoteRes.body.data.id });
  assert.equal(orderRes.status, 201);
  return { token, quoteId: quoteRes.body.data.id, orderId: orderRes.body.data.id, order: orderRes.body.data };
}

test("scheduler registers ecommerce-order-payment-expiry", () => {
  assert.ok(schedulerRepeatableJobs.some((j) => j.name === "ecommerce-order-payment-expiry"));
});

test("customer order POST blocked without payment and without test harness", async () => {
  disableEcommercePaymentsTestHarness();
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
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
  const blocked = await request(app)
    .post("/api/v1/app/shop/orders")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("o") })
    .send({ quoteId: quoteRes.body.data.id });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.error?.code, "PAYMENT_NOT_AVAILABLE");
});

test("payment expiry job releases stock without GET", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId } = await quoteAndOrder({ tenant, branch, product, customer });
  await EcommerceOrder.updateOne(
    { _id: orderId },
    { $set: { expiresAt: new Date(Date.now() - 1000) } },
  );
  await runEcommerceOrderPaymentExpiry(new Date());
  const row = await EcommerceOrder.findById(orderId).lean();
  assert.equal(row.status, EcommerceOrderStatus.PAYMENT_EXPIRED);
  assert.equal(row.stockReleaseReason, EcommerceStockReleaseReason.PAYMENT_WINDOW_EXPIRED);
  const held = await EcommerceStockReservation.countDocuments({ orderId, releasedAt: null });
  assert.equal(held, 0);
  await runEcommerceOrderPaymentExpiry(new Date());
  const row2 = await EcommerceOrder.findById(orderId).lean();
  assert.equal(row2.status, EcommerceOrderStatus.PAYMENT_EXPIRED);
});

test("customer cancel vs expiry race releases once", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId } = await quoteAndOrder({ tenant, branch, product, customer });
  await EcommerceOrder.updateOne(
    { _id: orderId },
    { $set: { expiresAt: new Date(Date.now() - 1000) } },
  );
  const [cancelRes] = await Promise.all([
    request(app)
      .post(`/api/v1/app/shop/orders/${orderId}/cancel`)
      .set({ authorization: `Bearer ${token}` })
      .send({ reason: "Customer cancelled during payment window" }),
    runEcommerceOrderPaymentExpiry(new Date()),
  ]);
  assert.ok(
    [200, 422].includes(cancelRes.status),
    `cancel status ${cancelRes.status}: ${JSON.stringify(cancelRes.body?.error ?? {})}`,
  );
  const order = await EcommerceOrder.findById(orderId).lean();
  assert.ok(
    [EcommerceOrderStatus.CANCELLED, EcommerceOrderStatus.PAYMENT_EXPIRED].includes(order.status),
    `terminal status must be cancel or expiry, got ${order.status}`,
  );
  const released = await EcommerceStockReservation.countDocuments({ orderId, releasedAt: { $ne: null } });
  const held = await EcommerceStockReservation.countDocuments({ orderId, releasedAt: null });
  assert.equal(released, 1);
  assert.equal(held, 0);
});

test("quote blocked when HSN/SAC mapping missing", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  await enableStore(tenant);
  await ecommerce.putTaxSettings({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: {
      rates: [{ code: "GST_3", rateBps: 300, active: true }],
      defaultClassification: "GST_3",
      hsnSacMappings: [],
    },
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
      name: "NoHsn",
      slug: "no-hsn",
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
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await request(app)
    .put("/api/v1/app/shop/cart")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("c") })
    .send({ lines: [{ productId: product.id, quantity: 1 }] });
  const res = await request(app)
    .post("/api/v1/app/shop/quotes")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("q") })
    .send({
      fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
      pickupBranchId: branch._id,
    });
  assert.equal(res.status, 422);
});

test("store downgrade blocks new quotes", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch });
  await Tenant.updateOne({ _id: tenant._id }, { $set: { "operations.ecommerceEnabled": false } });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await request(app)
    .put("/api/v1/app/shop/cart")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("c") })
    .send({ lines: [{ productId: product.id, quantity: 1 }] });
  const res = await request(app)
    .post("/api/v1/app/shop/quotes")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("q") })
    .send({
      fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
      pickupBranchId: branch._id,
    });
  assert.equal(res.status, 403);
});
