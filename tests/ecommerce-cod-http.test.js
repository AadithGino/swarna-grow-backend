import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceFulfilmentMode,
  EcommerceOrderStatus,
  EcommercePaymentMethod,
  PlanTier,
  TenantRole,
} from "../src/constants/enums.js";
import { EcommerceOrder, Tenant } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import {
  disableEcommercePaymentsTestHarness,
  taxReadyCatalogBody,
  taxReadyFulfilmentBody,
} from "./helpers/ecommerce-checkout-fixtures.js";
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { runEcommerceOrderPaymentExpiry } from "../src/services/ecommerce-order-payment-expiry.service.js";
import { runEcommerceCodAcceptanceExpiry } from "../src/services/ecommerce-cod-acceptance-expiry.service.js";

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

async function seedCheckoutReady({ tenant, user, branch, serviceable = ["686692"], codPincodes = ["686692"] }) {
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
      serviceablePincodes: serviceable,
      deliveryChargePaise: 0,
      codEnabled: codPincodes.length > 0,
      codPincodes,
    });
}

async function seedProduct(tenant, user) {
  const product = await ecommerce.createProduct({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: {
      name: "Ring",
      slug: `ring-${createId("s").slice(-6)}`,
      priceMode: "FIXED",
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

test("admin rejects COD pincode outside serviceable list", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  await seedCheckoutReady({ tenant, user, branch, serviceable: ["682001"], codPincodes: [] });
  const get = await request(app)
    .get("/api/v1/admin/ecommerce/fulfilment-settings")
    .set(adminHeaders(user));
  const res = await request(app)
    .put("/api/v1/admin/ecommerce/fulfilment-settings")
    .set(adminHeaders(user))
    .send({
      expectedVersion: get.body.data.version,
      codEnabled: true,
      codPincodes: ["686692"],
    });
  assert.ok(res.status === 422 || res.status === 400);
});

test("COD order places without online payment rollout; payment intent blocked", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await seedCheckoutReady({ tenant, user, branch });
  const product = await seedProduct(tenant, user);
  const token = await customerToken({ tenant, branch, customer });
  const addr = await request(app)
    .post("/api/v1/app/shop/addresses")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("a") })
    .send({
      line1: "Home",
      city: "Kottayam",
      state: "Kerala",
      pincode: "686692",
    });
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
  assert.equal(quote.status, 201);
  assert.equal(quote.body.data.paymentMethod, EcommercePaymentMethod.COD);
  assert.equal(quote.body.data.paymentAllowed, false);
  assert.equal(quote.body.data.orderPlacementAllowed, true);

  const order = await request(app)
    .post("/api/v1/app/shop/orders")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("o") })
    .send({ quoteId: quote.body.data.id });
  assert.equal(order.status, 201);
  assert.equal(order.body.data.status, EcommerceOrderStatus.COD_PENDING_ACCEPTANCE);
  assert.equal(order.body.data.paymentAllowed, false);
  assert.equal(order.body.data.paymentCompleted, false);

  const pay = await request(app)
    .post(`/api/v1/app/shop/orders/${order.body.data.id}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("p") })
    .send({ redirectUrl: "https://example.com/return" });
  assert.equal(pay.status, 422);
});

test("online order still requires payment capability", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await seedCheckoutReady({ tenant, user, branch });
  const product = await seedProduct(tenant, user);
  const token = await customerToken({ tenant, branch, customer });
  const addr = await request(app)
    .post("/api/v1/app/shop/addresses")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("a") })
    .send({
      line1: "Home",
      city: "Kottayam",
      state: "Kerala",
      pincode: "686692",
    });
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
    });
  assert.equal(quote.status, 201);
  const order = await request(app)
    .post("/api/v1/app/shop/orders")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("o") })
    .send({ quoteId: quote.body.data.id });
  assert.equal(order.status, 422);
});

test("COD acceptance expiry does not use payment expiry sweep", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await seedCheckoutReady({ tenant, user, branch });
  const product = await seedProduct(tenant, user);
  const token = await customerToken({ tenant, branch, customer });
  const addr = await request(app)
    .post("/api/v1/app/shop/addresses")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("a") })
    .send({
      line1: "Home",
      city: "Kottayam",
      state: "Kerala",
      pincode: "686692",
    });
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
  const orderId = order.body.data.id;
  await EcommerceOrder.updateOne(
    { _id: orderId },
    { $set: { expiresAt: new Date(Date.now() - 60_000) } },
  );
  await runEcommerceOrderPaymentExpiry(new Date());
  let row = await EcommerceOrder.findById(orderId).lean();
  assert.equal(row.status, EcommerceOrderStatus.COD_PENDING_ACCEPTANCE);
  await runEcommerceCodAcceptanceExpiry(new Date());
  row = await EcommerceOrder.findById(orderId).lean();
  assert.equal(row.status, EcommerceOrderStatus.CANCELLED);
});

test("staff accept, courier collection, delivery proof, and delivered", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await seedCheckoutReady({ tenant, user, branch });
  const product = await seedProduct(tenant, user);
  const token = await customerToken({ tenant, branch, customer });
  const addr = await request(app)
    .post("/api/v1/app/shop/addresses")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("a") })
    .send({
      line1: "Home",
      city: "Kottayam",
      state: "Kerala",
      pincode: "686692",
    });
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
  const orderId = order.body.data.id;
  const staffAuth = {
    authorization: `Bearer ${bearerFor(user, ROLE_PERMISSIONS[TenantRole.TENANT_ADMIN])}`,
  };
  const accept = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/cod/accept`)
    .set(staffAuth)
    .send({ expectedVersion: order.body.data.version });
  assert.equal(accept.status, 200);
  assert.equal(accept.body.data.status, EcommerceOrderStatus.PROCESSING);

  const shipped = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/fulfilment-transition`)
    .set(staffAuth)
    .send({ expectedVersion: accept.body.data.version, targetStatus: EcommerceOrderStatus.SHIPPED });
  assert.equal(shipped.status, 200);

  const handoverBlock = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/fulfilment-transition`)
    .set(staffAuth)
    .send({ expectedVersion: shipped.body.data.version, targetStatus: EcommerceOrderStatus.DELIVERED });
  assert.equal(handoverBlock.status, 422);

  const handover = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/delivery-handover`)
    .set({ ...staffAuth, "x-idempotency-key": createId("dh") })
    .send({
      expectedVersion: shipped.body.data.version,
      recipientName: "Customer",
      proofReference: "POD-REF-1",
    });
  assert.equal(handover.status, 200);

  const delivered = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/fulfilment-transition`)
    .set(staffAuth)
    .send({ expectedVersion: handover.body.data.version, targetStatus: EcommerceOrderStatus.DELIVERED });
  assert.equal(delivered.status, 200);

  const collect = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/courier-cod/confirm-collection`)
    .set({ ...staffAuth, "x-idempotency-key": createId("col") })
    .send({
      expectedVersion: delivered.body.data.version,
      reference: "COURIER-POD-REF-1",
      evidenceNote: "Manual courier POD from statement",
    });
  assert.equal(collect.status, 200);
  assert.equal(collect.body.data.courierCod.collectionStatus, "CONFIRMED");
});
