import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceFulfilmentMode,
  EcommercePriceMode,
  PlanTier,
} from "../src/constants/enums.js";
import { Session, Tenant } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import {
  enableEcommercePaymentsTestHarness,
  disableEcommercePaymentsTestHarness,
  taxReadyCatalogBody,
  taxReadyCheckoutTaxConfig,
  taxReadyFulfilmentBody,
} from "./helpers/ecommerce-checkout-fixtures.js";
import { DEMO_TAX_CLASSIFICATION, demoDisplayTaxBody } from "../scripts/lib/ecommerce-demo-tax.js";
import {
  demoCheckoutTaxConfigBody,
  shouldApplyDemoCheckoutFixture,
} from "../scripts/lib/ecommerce-demo-checkout.js";
import { evaluateCheckoutTaxReadiness } from "../src/lib/ecommerce-checkout-tax.js";
import { loadTaxSettings } from "../src/services/ecommerce.service.js";
import * as adminCommerce from "../src/services/ecommerce-admin-commerce.service.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  disableEcommercePaymentsTestHarness();
});

async function enableStore(tenant) {
  await Tenant.updateOne(
    { _id: tenant._id },
    {
      $set: {
        "subscription.planFeaturesSnapshot": { ecommerce: true, ecommercePayments: true },
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

test("GET fulfilment-settings lists checkout blockers when tax presentation unconfigured", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableStore(tenant);
  await ecommerce.putTaxSettings({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: taxReadyCatalogBody(),
  });
  const res = await request(app)
    .get("/api/v1/admin/ecommerce/fulfilment-settings")
    .set({ authorization: `Bearer ${bearerFor(user)}` });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.checkoutReadiness.checkoutTaxReady, false);
  const codes = res.body.data.checkoutReadiness.blockers.map((b) => b.code);
  assert.ok(codes.includes("TAX_PRESENTATION_UNCONFIGURED"));
});

test("component rules + HSN enable checkoutTaxReady", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableStore(tenant);
  await ecommerce.putTaxSettings({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: taxReadyCatalogBody(),
  });
  const putRes = await request(app)
    .put("/api/v1/admin/ecommerce/fulfilment-settings")
    .set({ authorization: `Bearer ${bearerFor(user)}`, "x-idempotency-key": createId("idem") })
    .send({
      expectedVersion: 1,
      checkoutTaxConfig: taxReadyCheckoutTaxConfig(),
    });
  assert.equal(putRes.status, 200);
  assert.equal(putRes.body.data.checkoutReadiness.checkoutTaxReady, true);
});

test("demo checkout fixture applies only with demo-only catalog tax", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "MEHER" });
  await enableStore(tenant);
  const req = {
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
  };
  await ecommerce.putTaxSettings({ ...req, body: demoDisplayTaxBody(1) });
  const taxSettings = await loadTaxSettings(tenant._id);
  const fulfilment = await adminCommerce.getAdminFulfilmentSettings(req);
  assert.equal(shouldApplyDemoCheckoutFixture(taxSettings, fulfilment), true);
  const cfg = demoCheckoutTaxConfigBody({ itemClassification: DEMO_TAX_CLASSIFICATION });
  const readiness = evaluateCheckoutTaxReadiness(taxSettings, { checkoutTaxConfig: cfg });
  assert.equal(readiness.ready, true);
});

test("POST quote returns paymentAllowed true under ECOMMERCE_PAYMENTS_TEST_HARNESS", async () => {
  enableEcommercePaymentsTestHarness();
  const { tenant, user, branch } = await seedTenantUser({});
  await enableStore(tenant);
  await ecommerce.putTaxSettings({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: taxReadyCatalogBody(),
  });
  const product = await ecommerce.createProduct({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: {
      name: "Pay ring",
      slug: "pay-ring",
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 25_000_00 },
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
    .set({ authorization: `Bearer ${bearerFor(user)}`, "x-idempotency-key": createId("f") })
    .send(taxReadyFulfilmentBody(branch._id));
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
  assert.equal(quoteRes.status, 201);
  assert.equal(quoteRes.body.data.checkoutTaxReady, true);
  assert.equal(quoteRes.body.data.paymentAllowed, true);
  assert.ok(Array.isArray(quoteRes.body.data.blockers));
});

test("POST quote succeeds intra-state pickup when checkout tax ready", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  await enableStore(tenant);
  await ecommerce.putTaxSettings({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: taxReadyCatalogBody(),
  });
  const product = await ecommerce.createProduct({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: {
      name: "Ring",
      slug: "ring",
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 50_000_00 },
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
    .set({ authorization: `Bearer ${bearerFor(user)}`, "x-idempotency-key": createId("f") })
    .send(taxReadyFulfilmentBody(branch._id));
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
  assert.equal(quoteRes.status, 201);
  assert.ok(quoteRes.body.data.totalPaise > 0);
  assert.ok(Array.isArray(quoteRes.body.data.lines));
});

test("customer cannot quote with another tenant pickup branch", async () => {
  const a = await seedTenantUser({ tenantCode: "MEHER" });
  const b = await seedTenantUser({ tenantCode: "KAIRALI" });
  await enableStore(a.tenant);
  await enableStore(b.tenant);
  for (const { tenant, user } of [a, b]) {
    await ecommerce.putTaxSettings({
      auth: { tenantId: tenant._id, id: user._id },
      tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
      body: taxReadyCatalogBody(),
    });
  }
  const product = await ecommerce.createProduct({
    auth: { tenantId: a.tenant._id, id: a.user._id },
    tenant: { ...a.tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: {
      name: "Item",
      slug: "item",
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 10_000_00 },
      taxClassification: "GST_3",
    },
  });
  await ecommerce.publishProduct({
    auth: { tenantId: a.tenant._id, id: a.user._id },
    tenant: { ...a.tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    params: { productId: product.id },
    body: { expectedVersion: 1 },
  });
  await request(app)
    .put("/api/v1/admin/ecommerce/fulfilment-settings")
    .set({ authorization: `Bearer ${bearerFor(a.user)}`, "x-idempotency-key": createId("fa") })
    .send(taxReadyFulfilmentBody(a.branch._id));
  const customer = await seedCustomer({ tenantId: a.tenant._id, branchId: a.branch._id });
  const token = await customerToken({ tenant: a.tenant, branch: a.branch, customer });
  await request(app)
    .put("/api/v1/app/shop/cart")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("c") })
    .send({ lines: [{ productId: product.id, quantity: 1 }] });
  const quoteRes = await request(app)
    .post("/api/v1/app/shop/quotes")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("q") })
    .send({
      fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
      pickupBranchId: b.branch._id,
    });
  assert.notEqual(quoteRes.status, 201);
});

test("quote returns CHECKOUT_NOT_READY blockers in details", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  await enableStore(tenant);
  await ecommerce.putTaxSettings({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: taxReadyCatalogBody(),
  });
  const product = await ecommerce.createProduct({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: {
      name: "Chain",
      slug: "chain",
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 20_000_00 },
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
  assert.equal(res.body.error?.code, "CHECKOUT_NOT_READY");
  const details = res.body.error?.details;
  const blockers = Array.isArray(details)
    ? details
    : details?.blockers;
  assert.ok(Array.isArray(blockers));
  assert.ok(blockers.length > 0);
});
