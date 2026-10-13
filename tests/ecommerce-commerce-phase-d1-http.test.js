import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceFulfilmentMode,
  EcommerceOrderStatus,
  EcommercePriceMode,
  EcommerceQuoteStatus,
  EcommerceStockPolicy,
  PlanTier,
} from "../src/constants/enums.js";
import {
  disableEcommercePaymentsTestHarness,
  enableEcommercePaymentsTestHarness,
  taxReadyCatalogBody,
  taxReadyFulfilmentBody,
  taxReadyStorePolicies,
} from "./helpers/ecommerce-checkout-fixtures.js";
import {
  EcommerceOrder,
  EcommercePriceQuote,
  EcommerceStockReservation,
  Session,
  Tenant,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import { runEcommerceQuoteExpiry } from "../src/services/ecommerce-quote-expiry.service.js";
import { schedulerRepeatableJobs } from "../src/schedulers/repeatable-jobs.js";
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

async function seedTaxReadyProduct({ tenant, user, branch }) {
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
      name: "Chain",
      slug: `chain-${createId("slug").slice(-10)}`,
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
    .send({ stockPolicy: EcommerceStockPolicy.QUANTITY_TRACKED, quantityOnHand: 5 });
  return { product, adminHeaders };
}

async function activeQuoteForCustomer({ tenant, branch, product, customer }) {
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
  return { token, quoteId: quoteRes.body.data.id };
}

test("scheduler registers ecommerce-quote-expiry job", () => {
  assert.ok(
    schedulerRepeatableJobs.some((j) => j.name === "ecommerce-quote-expiry"),
    "ecommerce-quote-expiry must be registered on the maintenance scheduler",
  );
});

test("order blocked when checkout tax not configured", async () => {
  disableEcommercePaymentsTestHarness();
  const { tenant, user, branch } = await seedTenantUser({});
  await enableStore(tenant);
  await ecommerce.putTaxSettings({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: {
      rates: [{ code: "GST_3", rateBps: 300, active: true }],
      defaultClassification: "GST_3",
    },
  });
  const product = await ecommerce.createProduct({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: {
      name: "Raw",
      slug: "raw",
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
    .put("/api/v1/admin/ecommerce/fulfilment-settings")
    .set({
      authorization: `Bearer ${bearerFor(user)}`,
      "x-idempotency-key": createId("ful"),
    })
    .send({
      expectedVersion: 1,
      pickupEnabled: true,
      pickupBranchIds: [branch._id],
      pendingPaymentWindowMinutes: 30,
      storePolicies: taxReadyStorePolicies(),
    });
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
  assert.equal(quoteRes.status, 422);
  const quoteErr = JSON.stringify(quoteRes.body.error ?? {});
  assert.match(quoteErr, /tax|checkout|CHECKOUT/i);
  const orderRes = await request(app)
    .post("/api/v1/app/shop/orders")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("o") })
    .send({ quoteId: createId("fake") });
  assert.ok([404, 422].includes(orderRes.status));
});

test("creates PENDING_PAYMENT order from active quote and transfers reservation", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product, adminHeaders } = await seedTaxReadyProduct({ tenant, user, branch });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, quoteId } = await activeQuoteForCustomer({
    tenant,
    branch,
    product,
    customer,
  });
  const idem = createId("ord");
  const o1 = await request(app)
    .post("/api/v1/app/shop/orders")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem,  })
    .send({ quoteId });
  assert.equal(o1.status, 201);
  assert.equal(o1.body.data.status, EcommerceOrderStatus.PENDING_PAYMENT);
  assert.equal(o1.body.data.paymentAllowed, true);
  assert.equal(o1.body.data.paymentCompleted, false);
  assert.match(String(o1.body.data.statusLabel), /not charged/i);

  const quote = await EcommercePriceQuote.findById(quoteId).lean();
  assert.equal(quote.status, EcommerceQuoteStatus.CONSUMED);
  assert.equal(quote.orderId, o1.body.data.id);

  const onOrder = await EcommerceStockReservation.countDocuments({
    quoteId,
    orderId: o1.body.data.id,
    releasedAt: null,
  });
  assert.equal(onOrder, 1);

  const o2 = await request(app)
    .post("/api/v1/app/shop/orders")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem,  })
    .send({ quoteId });
  assert.equal(o2.status, 200);
  assert.equal(o2.body.data.id, o1.body.data.id);

  const inv = await request(app)
    .get(`/api/v1/admin/ecommerce/inventory/${product.id}`)
    .set(adminHeaders);
  assert.equal(inv.body.data.availableQuantity, 4);

  const list = await request(app)
    .get("/api/v1/app/shop/orders")
    .set({ authorization: `Bearer ${token}` });
  assert.equal(list.status, 200);
  assert.equal(Array.isArray(list.body.data) ? list.body.data.length : list.body.data.items.length, 1);

  const detail = await request(app)
    .get(`/api/v1/app/shop/orders/${o1.body.data.id}`)
    .set({ authorization: `Bearer ${token}` });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.quoteId, quoteId);

  const admin = await request(app)
    .get(`/api/v1/admin/ecommerce/orders/${o1.body.data.id}`)
    .set(adminHeaders);
  assert.equal(admin.status, 200);
  assert.equal(admin.body.data.customerId, customer._id);
});

test("concurrent order posts yield one order", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedTaxReadyProduct({ tenant, user, branch });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, quoteId } = await activeQuoteForCustomer({
    tenant,
    branch,
    product,
    customer,
  });
  const idem = createId("ord");
  const body = { quoteId };
  const headers = { authorization: `Bearer ${token}`, "x-idempotency-key": idem,  };
  const [a, b] = await Promise.all([
    request(app).post("/api/v1/app/shop/orders").set(headers).send(body),
    request(app).post("/api/v1/app/shop/orders").set(headers).send(body),
  ]);
  assert.ok([a.status, b.status].includes(201));
  assert.equal(a.body.data.id, b.body.data.id);
  assert.ok([a.status, b.status].every((s) => s === 201 || s === 200));
  const orderCount = await EcommerceOrder.countDocuments({ quoteId });
  assert.equal(orderCount, 1);
});

test("expiry job does not release stock owned by pending order", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedTaxReadyProduct({ tenant, user, branch });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, quoteId } = await activeQuoteForCustomer({
    tenant,
    branch,
    product,
    customer,
  });
  const orderRes = await request(app)
    .post("/api/v1/app/shop/orders")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("o"),  })
    .send({ quoteId });
  assert.equal(orderRes.status, 201);
  await EcommercePriceQuote.updateOne(
    { _id: quoteId },
    { $set: { expiresAt: new Date(Date.now() - 60_000) } },
  );
  await runEcommerceQuoteExpiry(new Date());
  const held = await EcommerceStockReservation.countDocuments({
    orderId: orderRes.body.data.id,
    releasedAt: null,
  });
  assert.equal(held, 1);
});

test("order rejected when quote expired before create", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedTaxReadyProduct({ tenant, user, branch });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, quoteId } = await activeQuoteForCustomer({
    tenant,
    branch,
    product,
    customer,
  });
  await EcommercePriceQuote.updateOne(
    { _id: quoteId },
    { $set: { expiresAt: new Date(Date.now() - 1000) } },
  );
  await runEcommerceQuoteExpiry(new Date());
  const res = await request(app)
    .post("/api/v1/app/shop/orders")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("o"),  })
    .send({ quoteId });
  assert.equal(res.status, 422);
  assert.equal(res.body.error?.code, "QUOTE_NOT_AVAILABLE");
});

test("order idempotency rejects mismatched quoteId", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedTaxReadyProduct({ tenant, user, branch });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, quoteId } = await activeQuoteForCustomer({
    tenant,
    branch,
    product,
    customer,
  });
  const idem = createId("ord");
  await request(app)
    .post("/api/v1/app/shop/orders")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem,  })
    .send({ quoteId });
  const mismatch = await request(app)
    .post("/api/v1/app/shop/orders")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem,  })
    .send({ quoteId: createId("other") });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error?.code, "IDEMPOTENCY_KEY_REUSED");
});

test("customer cannot read another customer order in same tenant", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedTaxReadyProduct({ tenant, user, branch });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile: "9000000101" });
  const { token, quoteId } = await activeQuoteForCustomer({
    tenant,
    branch,
    product,
    customer,
  });
  const orderRes = await request(app)
    .post("/api/v1/app/shop/orders")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("o"),  })
    .send({ quoteId });
  const other = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile: "9000000102" });
  const otherToken = await customerToken({ tenant, branch, customer: other });
  const res = await request(app)
    .get(`/api/v1/app/shop/orders/${orderRes.body.data.id}`)
    .set({ authorization: `Bearer ${otherToken}` });
  assert.equal(res.status, 404);
});
