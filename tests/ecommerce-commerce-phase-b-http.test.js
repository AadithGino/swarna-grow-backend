import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceCheckoutTaxPresentation,
  EcommercePriceMode,
  EcommerceStockPolicy,
  PlanTier,
  TenantRole,
} from "../src/constants/enums.js";
import { Session, Tenant } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import { assertFulfilmentSelection } from "../src/lib/ecommerce-fulfilment.js";
import { signAccessToken } from "../src/services/token.service.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function enableEcommerce(tenant) {
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

function adminHeaders(user, key = createId("idem")) {
  return {
    authorization: `Bearer ${bearerFor(user)}`,
    "x-idempotency-key": key,
  };
}

async function customerAccessToken({ tenant, branch, customer }) {
  const session = await Session.create({
    _id: createId("session"),
    customerId: customer._id,
    tenantId: tenant._id,
    deviceId: "customer-device",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "android",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return signAccessToken({
    id: customer._id,
    type: "CUSTOMER",
    tenantId: tenant._id,
    branchId: branch._id,
    role: "CUSTOMER",
    permissions: [],
    deviceId: "customer-device",
    securityVersion: 0,
    sessionId: session._id,
  });
}

async function seedPublishedProduct(tenant, user) {
  await enableEcommerce(tenant);
  await ecommerce.putTaxSettings({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: {
      ...tenant.toObject(),
      subscription: { planFeaturesSnapshot: { ecommerce: true } },
    },
    body: {
      rates: [{ code: "GST_3", rateBps: 300, active: true }],
      defaultClassification: "GST_3",
    },
  });
  const product = await ecommerce.createProduct({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: {
      ...tenant.toObject(),
      subscription: { planFeaturesSnapshot: { ecommerce: true } },
    },
    body: {
      name: "Ring",
      slug: "ring",
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 50_000 },
      taxClassification: "GST_3",
    },
  });
  await ecommerce.publishProduct({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: {
      ...tenant.toObject(),
      subscription: { planFeaturesSnapshot: { ecommerce: true } },
    },
    params: { productId: product.id },
    body: { expectedVersion: 1 },
  });
  return product;
}

test("HTTP inventory patch requires ecommerce write permission", async () => {
  const { tenant, user } = await seedTenantUser({});
  const product = await seedPublishedProduct(tenant, user);
  const res = await request(app)
    .patch(`/api/v1/admin/ecommerce/inventory/${product.id}`)
    .set({
      authorization: `Bearer ${bearerFor(user, ROLE_PERMISSIONS[TenantRole.BRANCH_MANAGER])}`,
    })
    .send({ stockPolicy: EcommerceStockPolicy.MADE_TO_ORDER });
  assert.equal(res.status, 403);
});

test("HTTP inventory tenant isolation on read", async () => {
  const a = await seedTenantUser({ tenantCode: "INV_A" });
  const b = await seedTenantUser({ tenantCode: "INV_B" });
  await enableEcommerce(a.tenant);
  const product = await seedPublishedProduct(a.tenant, a.user);
  const res = await request(app)
    .get(`/api/v1/admin/ecommerce/inventory/${product.id}`)
    .set(adminHeaders(b.user));
  assert.equal(res.status, 404);
});

test("HTTP quantity tracked adjust and zero stock blocks cart", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const product = await seedPublishedProduct(tenant, user);
  const patchRes = await request(app)
    .patch(`/api/v1/admin/ecommerce/inventory/${product.id}`)
    .set(adminHeaders(user))
    .send({
      stockPolicy: EcommerceStockPolicy.QUANTITY_TRACKED,
      quantityOnHand: 1,
    });
  assert.equal(patchRes.status, 200);
  assert.equal(patchRes.body.data.availableQuantity, 1);

  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerAccessToken({ tenant, branch, customer });

  const cartOk = await request(app)
    .put("/api/v1/app/shop/cart")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("idem") })
    .send({ lines: [{ productId: product.id, quantity: 1 }] });
  assert.equal(cartOk.status, 200);

  const cartFail = await request(app)
    .put("/api/v1/app/shop/cart")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("idem2") })
    .send({ lines: [{ productId: product.id, quantity: 2 }] });
  assert.equal(cartFail.status, 422);
});

test("HTTP made-to-order inventory does not block cart quantity", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const product = await seedPublishedProduct(tenant, user);
  await request(app)
    .patch(`/api/v1/admin/ecommerce/inventory/${product.id}`)
    .set(adminHeaders(user))
    .send({ stockPolicy: EcommerceStockPolicy.MADE_TO_ORDER });

  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerAccessToken({ tenant, branch, customer });
  const res = await request(app)
    .put("/api/v1/app/shop/cart")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("idem") })
    .send({ lines: [{ productId: product.id, quantity: 3 }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.lines[0].availability.stockPolicy, EcommerceStockPolicy.MADE_TO_ORDER);
});

test("delivery stays disabled until configured; unserviceable pin rejected", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const putRes = await request(app)
    .put("/api/v1/admin/ecommerce/fulfilment-settings")
    .set(adminHeaders(user))
    .send({
      expectedVersion: 1,
      deliveryEnabled: true,
      serviceablePincodes: [],
      deliveryChargePaise: 5000,
    });
  assert.equal(putRes.status, 200);
  assert.equal(putRes.body.data.deliveryEnabled, false);

  await request(app)
    .put("/api/v1/admin/ecommerce/fulfilment-settings")
    .set(adminHeaders(user))
    .send({
      expectedVersion: putRes.body.data.version,
      deliveryEnabled: true,
      serviceablePincodes: ["682001"],
      deliveryChargePaise: 5000,
    });

  const mapped = {
    pickupEnabled: false,
    pickupBranchIds: [],
    deliveryEnabled: true,
    serviceablePincodes: ["682001"],
    deliveryChargePaise: 5000,
  };
  assert.throws(
    () => assertFulfilmentSelection(mapped, { mode: "DELIVERY", pincode: "682002" }),
    (err) => err.code === "FULFILMENT_UNAVAILABLE",
  );
});

test("checkout tax readiness blocked without accountant configuration", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  await ecommerce.putTaxSettings({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: {
      ...tenant.toObject(),
      subscription: { planFeaturesSnapshot: { ecommerce: true } },
    },
    body: {
      rates: [{ code: "GST_3", rateBps: 300, active: true }],
      defaultClassification: "GST_3",
      hsnSacMappings: [
        { classification: "GST_3", hsnSacCode: "7113", hsnSacType: "HSN" },
      ],
    },
  });
  const res = await request(app)
    .get("/api/v1/admin/ecommerce/fulfilment-settings")
    .set(adminHeaders(user));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.checkoutReadiness.checkoutUsable, false);
  assert.equal(res.body.data.checkoutReadiness.checkoutTaxReady, false);
  assert.ok(res.body.data.checkoutReadiness.blockers.length > 0);

  const putRes = await request(app)
    .put("/api/v1/admin/ecommerce/fulfilment-settings")
    .set(adminHeaders(user))
    .send({
      expectedVersion: res.body.data.version,
      checkoutTaxConfig: {
        presentation: EcommerceCheckoutTaxPresentation.ACCOUNTANT_COMPONENT_APPROVED,
        sellerLegalName: "Meher Jewellery LLP",
        sellerGstin: "32ABCDE1234F1Z5",
        registeredState: "Kerala",
        defaultPlaceOfSupplyState: "Kerala",
        defaultItemTaxClassification: "GST_3",
        accountantSignOffReference: "CA-2026-001",
        accountantApprovedAt: new Date().toISOString(),
        componentLines: [{ componentKey: "COMP_A", label: "Component A (accountant entered)", rateBps: 150 }],
        componentRules: [
          {
            supplyCase: "INTRA_STATE",
            componentLines: [{ componentKey: "COMP_A", label: "Component A (accountant entered)", rateBps: 150 }],
          },
        ],
        supportedDestinationStates: ["Kerala"],
      },
    });
  assert.equal(putRes.status, 200);
  assert.equal(putRes.body.data.checkoutReadiness.checkoutTaxReady, true);
  assert.equal(putRes.body.data.checkoutReadiness.checkoutUsable, false);
});

test("HTTP concurrent inventory adjust respects version", async () => {
  const { tenant, user } = await seedTenantUser({});
  const product = await seedPublishedProduct(tenant, user);
  const patchRes = await request(app)
    .patch(`/api/v1/admin/ecommerce/inventory/${product.id}`)
    .set(adminHeaders(user))
    .send({
      stockPolicy: EcommerceStockPolicy.QUANTITY_TRACKED,
      quantityOnHand: 5,
    });
  const version = patchRes.body.data.version;
  const [a, b] = await Promise.all([
    request(app)
      .post(`/api/v1/admin/ecommerce/inventory/${product.id}/adjust`)
      .set(adminHeaders(user, createId("a")))
      .send({ expectedVersion: version, deltaQuantity: -1, reason: "A" }),
    request(app)
      .post(`/api/v1/admin/ecommerce/inventory/${product.id}/adjust`)
      .set(adminHeaders(user, createId("b")))
      .send({ expectedVersion: version, deltaQuantity: -1, reason: "B" }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
});
