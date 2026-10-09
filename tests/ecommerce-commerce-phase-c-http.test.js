import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceFulfilmentMode,
  EcommercePriceMode,
  EcommerceStockPolicy,
  PlanTier,
} from "../src/constants/enums.js";
import { Session, Tenant } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import {
  disableEcommercePaymentsTestHarness,
  taxReadyCatalogBody,
  taxReadyFulfilmentBody,
} from "./helpers/ecommerce-checkout-fixtures.js";

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

async function seedReadyTenant({ tenant, user }) {
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
      name: "Bangle",
      slug: "bangle",
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

test("quote blocked when checkout tax not configured", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const product = await seedReadyTenant({ tenant, user });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await request(app)
    .put("/api/v1/app/shop/cart")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("c") })
    .send({ lines: [{ productId: product.id, quantity: 1 }] });
  const res = await request(app)
    .post("/api/v1/app/shop/quotes")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("q") })
    .send({ fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP, pickupBranchId: branch._id });
  assert.equal(res.status, 422);
  assert.equal(res.body.error?.code, "CHECKOUT_NOT_READY");
});

test("quote reserves stock and is idempotent", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const product = await seedReadyTenant({ tenant, user });
  const adminHeaders = {
    authorization: `Bearer ${bearerFor(user)}`,
    "x-idempotency-key": createId("idem"),
  };
  await request(app)
    .patch(`/api/v1/admin/ecommerce/inventory/${product.id}`)
    .set(adminHeaders)
    .send({ stockPolicy: EcommerceStockPolicy.QUANTITY_TRACKED, quantityOnHand: 2 });
  await request(app)
    .put("/api/v1/admin/ecommerce/fulfilment-settings")
    .set(adminHeaders)
    .send(taxReadyFulfilmentBody(branch._id));
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await request(app)
    .put("/api/v1/app/shop/cart")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("c") })
    .send({ lines: [{ productId: product.id, quantity: 1 }] });
  const idem = createId("quote");
  const q1 = await request(app)
    .post("/api/v1/app/shop/quotes")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem })
    .send({
      fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
      pickupBranchId: branch._id,
    });
  assert.equal(q1.status, 201);
  assert.equal(q1.body.data.paymentAllowed, false);
  const q2 = await request(app)
    .post("/api/v1/app/shop/quotes")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem })
    .send({
      fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
      pickupBranchId: branch._id,
    });
  assert.equal(q2.status, 200);
  assert.equal(q2.body.data.id, q1.body.data.id);
  assert.equal(q2.body.data.status, q1.body.data.status);
  const inv = await request(app)
    .get(`/api/v1/admin/ecommerce/inventory/${product.id}`)
    .set(adminHeaders);
  assert.equal(inv.body.data.availableQuantity, 1);
});
