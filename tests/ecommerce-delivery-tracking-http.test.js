import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceFulfilmentMode,
  EcommerceOrderStatus,
  EcommercePaymentMethod,
  PlanTier,
} from "../src/constants/enums.js";
import { Tenant } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import {
  disableEcommercePaymentsTestHarness,
  taxReadyCatalogBody,
  taxReadyFulfilmentBody,
} from "./helpers/ecommerce-checkout-fixtures.js";
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  disableEcommercePaymentsTestHarness();
});

function adminHeaders(user, key = createId("idem")) {
  return {
    authorization: `Bearer ${bearerFor(user)}`,
    "x-idempotency-key": key,
  };
}

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
  const { Session } = await import("../src/models/index.js");
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

async function seedDeliveryCodOrder({ tenant, user, branch, customer, requireTracking }) {
  await enableStore(tenant);
  await ecommerce.putTaxSettings({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: taxReadyCatalogBody(),
  });
  await request(app)
    .put("/api/v1/admin/ecommerce/fulfilment-settings")
    .set(adminHeaders(user))
    .send({
      ...taxReadyFulfilmentBody(branch._id),
      deliveryEnabled: true,
      serviceablePincodes: ["686692"],
      deliveryChargePaise: 0,
      codEnabled: true,
      codPincodes: ["686692"],
      requireCourierTrackingForShipped: requireTracking === true,
    });
  const product = await ecommerce.createProduct({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: {
      name: "Bangle",
      slug: `bangle-${createId("s").slice(-6)}`,
      priceMode: "FIXED",
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
  const token = await customerToken({ tenant, branch, customer });
  const addr = await request(app)
    .post("/api/v1/app/shop/addresses")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("a") })
    .send({ line1: "Home", city: "Kottayam", state: "Kerala", pincode: "686692" });
  await request(app)
    .put("/api/v1/app/shop/cart")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("c") })
    .send({ lines: [{ productId: product.id, quantity: 1 }] });
  const quote = await request(app)
    .post("/api/v1/app/shop/quotes")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("q") })
    .send({
      fulfilmentMode: EcommerceFulfilmentMode.DELIVERY,
      addressId: addr.body.data.id,
      paymentMethod: EcommercePaymentMethod.COD,
    });
  const order = await request(app)
    .post("/api/v1/app/shop/orders")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("o") })
    .send({ quoteId: quote.body.data.id });
  assert.equal(order.status, 201);
  const orderId = order.body.data.id;
  const accept = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/cod/accept`)
    .set(adminHeaders(user))
    .send({ expectedVersion: order.body.data.version, reason: "ok" });
  assert.equal(accept.status, 200);
  const detail = await request(app)
    .get(`/api/v1/admin/ecommerce/orders/${orderId}`)
    .set(adminHeaders(user));
  assert.equal(detail.status, 200);
  return { user, token, orderId, version: Number(detail.body.data.version) };
}

test("delivery tracking required blocks SHIPPED until courier details saved", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, version } = await seedDeliveryCodOrder({
    tenant,
    user,
    branch,
    customer,
    requireTracking: true,
  });
  const blocked = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/fulfilment-transition`)
    .set(adminHeaders(user))
    .send({
      expectedVersion: version,
      targetStatus: EcommerceOrderStatus.SHIPPED,
    });
  assert.equal(blocked.status, 422, JSON.stringify(blocked.body));
  const beforePatch = await request(app)
    .get(`/api/v1/admin/ecommerce/orders/${orderId}`)
    .set(adminHeaders(user));
  const patch = await request(app)
    .patch(`/api/v1/admin/ecommerce/orders/${orderId}/delivery-tracking`)
    .set(adminHeaders(user))
    .send({
      expectedVersion: Number(beforePatch.body.data.version),
      carrierName: "BlueDart",
      trackingNumber: "BD123",
      trackingUrl: "https://example.com/track/BD123",
    });
  if (patch.status !== 200) {
    assert.fail(
      `patch ${patch.status} expectedVersion=${beforePatch.body.data.version} body=${JSON.stringify(patch.body)}`,
    );
  }
  const patchVersion = Number(patch.body.data.version);
  const shipped = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/fulfilment-transition`)
    .set(adminHeaders(user))
    .send({
      expectedVersion: patchVersion,
      targetStatus: EcommerceOrderStatus.SHIPPED,
    });
  assert.equal(shipped.status, 200, JSON.stringify(shipped.body));
});

test("pickup order rejects delivery tracking patch", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId } = await seedDeliveryCodOrder({
    tenant,
    user,
    branch,
    customer,
    requireTracking: false,
  });
  const { EcommerceOrder } = await import("../src/models/index.js");
  await EcommerceOrder.updateOne(
    { _id: orderId, tenantId: tenant._id },
    { $set: { fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP } },
  );
  const detail = await request(app)
    .get(`/api/v1/admin/ecommerce/orders/${orderId}`)
    .set(adminHeaders(user));
  const patch = await request(app)
    .patch(`/api/v1/admin/ecommerce/orders/${orderId}/delivery-tracking`)
    .set(adminHeaders(user))
    .send({ expectedVersion: Number(detail.body.data.version), carrierName: "X" });
  assert.equal(patch.status, 422);
});
