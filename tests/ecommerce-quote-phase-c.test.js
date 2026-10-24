import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceFulfilmentMode,
  EcommercePriceMode,
  EcommerceQuoteStatus,
  EcommerceStockPolicy,
  PlanTier,
} from "../src/constants/enums.js";
import {
  EcommercePriceQuote,
  EcommerceStockReservation,
  Session,
  Tenant,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import { runEcommerceQuoteExpiry } from "../src/services/ecommerce-quote-expiry.service.js";
import { revalidateQuoteForOrder } from "../src/lib/ecommerce-quote-revalidation.js";
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import {
  disableEcommercePaymentsTestHarness,
  taxReadyCatalogBody,
  taxReadyFulfilmentBody,
} from "./helpers/ecommerce-checkout-fixtures.js";

const app = createApp();
const taxReadyTenantIds = new Set();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  disableEcommercePaymentsTestHarness();
  taxReadyTenantIds.clear();
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

async function seedProduct(tenant, user, { slug, name }) {
  const tenantKey = String(tenant._id);
  if (!taxReadyTenantIds.has(tenantKey)) {
    await enableStore(tenant);
    await ecommerce.putTaxSettings({
      auth: { tenantId: tenant._id, id: user._id },
      tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
      body: taxReadyCatalogBody(),
    });
    taxReadyTenantIds.add(tenantKey);
  }
  const product = await ecommerce.createProduct({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: {
      name,
      slug,
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
  return product;
}

async function configureFulfilment(user, branchId) {
  const adminHeaders = {
    authorization: `Bearer ${bearerFor(user)}`,
    "x-idempotency-key": createId("idem"),
  };
  await request(app)
    .put("/api/v1/admin/ecommerce/fulfilment-settings")
    .set(adminHeaders)
    .send(taxReadyFulfilmentBody(branchId));
  return adminHeaders;
}

test("scheduled expiry releases stock without GET quote", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const product = await seedProduct(tenant, user, { slug: "ring", name: "Ring" });
  const adminHeaders = await configureFulfilment(user, branch._id);
  await request(app)
    .patch(`/api/v1/admin/ecommerce/inventory/${product.id}`)
    .set(adminHeaders)
    .send({ stockPolicy: EcommerceStockPolicy.QUANTITY_TRACKED, quantityOnHand: 1 });
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
  const quoteId = quoteRes.body.data.id;
  await EcommercePriceQuote.updateOne(
    { _id: quoteId },
    { $set: { expiresAt: new Date(Date.now() - 1000) } },
  );
  await runEcommerceQuoteExpiry(new Date());
  const quote = await EcommercePriceQuote.findById(quoteId).lean();
  assert.equal(quote.status, EcommerceQuoteStatus.EXPIRED);
  const reservations = await EcommerceStockReservation.find({ quoteId }).lean();
  assert.ok(reservations.every((r) => r.releasedAt));
  const inv = await request(app)
    .get(`/api/v1/admin/ecommerce/inventory/${product.id}`)
    .set(adminHeaders);
  assert.equal(inv.body.data.availableQuantity, 1);
});

test("multi-line quote rolls back when one line lacks stock", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const a = await seedProduct(tenant, user, { slug: "a", name: "A" });
  const b = await seedProduct(tenant, user, { slug: "b", name: "B" });
  const adminHeaders = await configureFulfilment(user, branch._id);
  await request(app)
    .patch(`/api/v1/admin/ecommerce/inventory/${a.id}`)
    .set(adminHeaders)
    .send({ stockPolicy: EcommerceStockPolicy.QUANTITY_TRACKED, quantityOnHand: 5 });
  await request(app)
    .patch(`/api/v1/admin/ecommerce/inventory/${b.id}`)
    .set(adminHeaders)
    .send({ stockPolicy: EcommerceStockPolicy.MADE_TO_ORDER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await request(app)
    .put("/api/v1/app/shop/cart")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("c") })
    .send({
      lines: [
        { productId: a.id, quantity: 1 },
        { productId: b.id, quantity: 1 },
      ],
    });
  await request(app)
    .patch(`/api/v1/admin/ecommerce/inventory/${b.id}`)
    .set(adminHeaders)
    .send({ stockPolicy: EcommerceStockPolicy.QUANTITY_TRACKED, quantityOnHand: 0 });
  const res = await request(app)
    .post("/api/v1/app/shop/quotes")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("q") })
    .send({
      fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
      pickupBranchId: branch._id,
    });
  assert.equal(res.status, 422);
  const quoteCount = await EcommercePriceQuote.countDocuments({ tenantId: tenant._id });
  assert.equal(quoteCount, 0);
  const reservationCount = await EcommerceStockReservation.countDocuments({
    tenantId: tenant._id,
    releasedAt: null,
  });
  assert.equal(reservationCount, 0);
});

test("concurrent quote requests respect single unit stock", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const product = await seedProduct(tenant, user, { slug: "solo", name: "Solo" });
  const adminHeaders = await configureFulfilment(user, branch._id);
  await request(app)
    .patch(`/api/v1/admin/ecommerce/inventory/${product.id}`)
    .set(adminHeaders)
    .send({ stockPolicy: EcommerceStockPolicy.QUANTITY_TRACKED, quantityOnHand: 1 });
  const c1 = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile: "9000000001" });
  const c2 = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile: "9000000002" });
  const t1 = await customerToken({ tenant, branch, customer: c1 });
  const t2 = await customerToken({ tenant, branch, customer: c2 });
  for (const token of [t1, t2]) {
    await request(app)
      .put("/api/v1/app/shop/cart")
      .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("c") })
      .send({ lines: [{ productId: product.id, quantity: 1 }] });
  }
  const [r1, r2] = await Promise.all([
    request(app)
      .post("/api/v1/app/shop/quotes")
      .set({ authorization: `Bearer ${t1}`, "x-idempotency-key": createId("q1") })
      .send({
        fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
        pickupBranchId: branch._id,
      }),
    request(app)
      .post("/api/v1/app/shop/quotes")
      .set({ authorization: `Bearer ${t2}`, "x-idempotency-key": createId("q2") })
      .send({
        fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
        pickupBranchId: branch._id,
      }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [201, 422]);
});

test("simultaneous idempotent quote retries return one quote", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const product = await seedProduct(tenant, user, { slug: "idem", name: "Idem" });
  const adminHeaders = await configureFulfilment(user, branch._id);
  await request(app)
    .patch(`/api/v1/admin/ecommerce/inventory/${product.id}`)
    .set(adminHeaders)
    .send({ stockPolicy: EcommerceStockPolicy.QUANTITY_TRACKED, quantityOnHand: 2 });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await request(app)
    .put("/api/v1/app/shop/cart")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("c") })
    .send({ lines: [{ productId: product.id, quantity: 1 }] });
  const idem = createId("quote");
  const body = {
    fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
    pickupBranchId: branch._id,
  };
  const [a, b] = await Promise.all([
    request(app)
      .post("/api/v1/app/shop/quotes")
      .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem })
      .send(body),
    request(app)
      .post("/api/v1/app/shop/quotes")
      .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem })
      .send(body),
  ]);
  const quoteId = a.body.data?.id ?? b.body.data?.id;
  assert.ok(quoteId);
  assert.equal(a.body.data.id, b.body.data.id);
  assert.ok([a.status, b.status].includes(201));
  assert.ok([a.status, b.status].every((s) => s === 201 || s === 200));
  const activeReservations = await EcommerceStockReservation.countDocuments({
    quoteId,
    releasedAt: null,
  });
  assert.equal(activeReservations, 1);
});

test("idempotency replay returns EXPIRED quote after expiry (same key, no new quote)", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const product = await seedProduct(tenant, user, { slug: "rekey", name: "Rekey" });
  await configureFulfilment(user, branch._id);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await request(app)
    .put("/api/v1/app/shop/cart")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("c") })
    .send({ lines: [{ productId: product.id, quantity: 1 }] });
  const idem = createId("quote");
  const body = {
    fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
    pickupBranchId: branch._id,
  };
  const first = await request(app)
    .post("/api/v1/app/shop/quotes")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem })
    .send(body);
  assert.equal(first.status, 201);
  await EcommercePriceQuote.updateOne(
    { _id: first.body.data.id },
    { $set: { expiresAt: new Date(Date.now() - 1000) } },
  );
  await runEcommerceQuoteExpiry(new Date());
  const replay = await request(app)
    .post("/api/v1/app/shop/quotes")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem })
    .send(body);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.id, first.body.data.id);
  assert.equal(replay.body.data.status, EcommerceQuoteStatus.EXPIRED);
  const quoteCount = await EcommercePriceQuote.countDocuments({
    tenantId: tenant._id,
    customerId: customer._id,
    idempotencyKey: idem,
  });
  assert.equal(quoteCount, 1);
});

test("idempotency replay after cancel and payload mismatch", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const product = await seedProduct(tenant, user, { slug: "cancel-idem", name: "Cancel" });
  await configureFulfilment(user, branch._id);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await request(app)
    .put("/api/v1/app/shop/cart")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("c") })
    .send({ lines: [{ productId: product.id, quantity: 1 }] });
  const idem = createId("quote");
  const body = {
    fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
    pickupBranchId: branch._id,
  };
  const created = await request(app)
    .post("/api/v1/app/shop/quotes")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem })
    .send(body);
  await request(app)
    .post(`/api/v1/app/shop/quotes/${created.body.data.id}/cancel`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("x") });
  const replay = await request(app)
    .post("/api/v1/app/shop/quotes")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem })
    .send(body);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.status, EcommerceQuoteStatus.CANCELLED);
  const mismatch = await request(app)
    .post("/api/v1/app/shop/quotes")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem })
    .send({ ...body, pincode: "682001" });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error?.code, "IDEMPOTENCY_KEY_REUSED");
});

test("cross-tenant quote access denied", async () => {
  const a = await seedTenantUser({ tenantCode: "QA" });
  const b = await seedTenantUser({ tenantCode: "QB" });
  await enableStore(b.tenant);
  const product = await seedProduct(a.tenant, a.user, { slug: "x", name: "X" });
  await configureFulfilment(a.user, a.branch._id);
  const customer = await seedCustomer({ tenantId: a.tenant._id, branchId: a.branch._id });
  const token = await customerToken({ tenant: a.tenant, branch: a.branch, customer });
  await request(app)
    .put("/api/v1/app/shop/cart")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("c") })
    .send({ lines: [{ productId: product.id, quantity: 1 }] });
  const quote = await request(app)
    .post("/api/v1/app/shop/quotes")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("q") })
    .send({
      fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
      pickupBranchId: a.branch._id,
    });
  const otherCustomer = await seedCustomer({ tenantId: b.tenant._id, branchId: b.branch._id });
  const otherToken = await customerToken({
    tenant: b.tenant,
    branch: b.branch,
    customer: otherCustomer,
  });
  const res = await request(app)
    .get(`/api/v1/app/shop/quotes/${quote.body.data.id}`)
    .set({ authorization: `Bearer ${otherToken}` });
  assert.equal(res.status, 404);
});

test("revalidation fails when tax settings version changes", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const product = await seedProduct(tenant, user, { slug: "tax", name: "Tax" });
  await configureFulfilment(user, branch._id);
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
  const row = await EcommercePriceQuote.findById(quoteRes.body.data.id).lean();
  await ecommerce.putTaxSettings({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: {
      expectedVersion: 1,
      rates: [{ code: "GST_3", rateBps: 300, active: true }],
      defaultClassification: "GST_3",
    },
  });
  const freshTenant = await Tenant.findById(tenant._id);
  const result = await revalidateQuoteForOrder({
    quoteRow: row,
    tenant: freshTenant,
    customerId: customer._id,
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.code === "TAX_CONFIG_CHANGED"));
});

test("store off blocks quote creation", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const product = await seedProduct(tenant, user, { slug: "off", name: "Off" });
  await configureFulfilment(user, branch._id);
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
