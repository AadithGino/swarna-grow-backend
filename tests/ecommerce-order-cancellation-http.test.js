import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceFulfilmentMode,
  EcommerceOrderCancellationRequestStatus,
  EcommerceOrderRefundSource,
  EcommerceOrderStatus,
  EcommercePaymentMethod,
  EcommerceStockPolicy,
  PlanTier,
  TenantRole,
} from "../src/constants/enums.js";
import {
  EcommerceInventory,
  EcommerceOrder,
  EcommerceOrderCancellationRequest,
  EcommercePaymentExceptionRefund,
  EcommerceStockReservation,
  Tenant,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import {
  disableEcommercePaymentsTestHarness,
  enableEcommercePaymentsTestHarness,
  taxReadyCatalogBody,
  taxReadyFulfilmentBody,
} from "./helpers/ecommerce-checkout-fixtures.js";
import {
  postCompletedWebhookHttp,
  quoteAndOrder,
  seedReady,
} from "./helpers/ecommerce-payment-test-flow.js";
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";

const app = createApp();

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
  disableEcommercePaymentsTestHarness();
});

function staffHeaders(user) {
  return {
    authorization: `Bearer ${bearerFor(user, ROLE_PERMISSIONS[TenantRole.TENANT_ADMIN])}`,
    "x-idempotency-key": createId("idem"),
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

async function seedCheckoutReady({ tenant, user, branch, qty = 5, trackInventory = false }) {
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
    .send({
      ...taxReadyFulfilmentBody(branch._id),
      deliveryEnabled: true,
      serviceablePincodes: ["686692"],
      deliveryChargePaise: 0,
      codEnabled: true,
      codPincodes: ["686692"],
    });
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
  if (trackInventory) {
    await request(app)
      .patch(`/api/v1/admin/ecommerce/inventory/${product.id}`)
      .set(adminHeaders)
      .send({ stockPolicy: EcommerceStockPolicy.QUANTITY_TRACKED, quantityOnHand: qty });
  }
  return { product, adminHeaders };
}

async function placeCodOrder({ tenant, branch, customer, product }) {
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
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  const order = await request(app)
    .post("/api/v1/app/shop/orders")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("o") })
    .send({ quoteId: quote.body.data.id });
  assert.equal(order.status, 201);
  return { token, orderId: order.body.data.id, productId: product.id };
}

test("customer direct cancel COD pending releases reservation once", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { product } = await seedCheckoutReady({ tenant, user, branch, trackInventory: true });
  const { token, orderId, productId } = await placeCodOrder({ tenant, branch, customer, product });

  const openBefore = await EcommerceStockReservation.countDocuments({
    tenantId: tenant._id,
    orderId,
    releasedAt: null,
  });
  assert.ok(openBefore >= 1);

  const cancel = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/cancel`)
    .set({ authorization: `Bearer ${token}` })
    .send({ reason: "Changed my mind" });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.data.status, EcommerceOrderStatus.CANCELLED);

  const openAfter = await EcommerceStockReservation.countDocuments({
    tenantId: tenant._id,
    orderId,
    releasedAt: null,
  });
  assert.equal(openAfter, 0);

  const inv = await EcommerceInventory.findOne({ tenantId: tenant._id, productId }).lean();
  assert.equal(inv?.quantityOnHand, 5);

  const again = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/cancel`)
    .set({ authorization: `Bearer ${token}` })
    .send({});
  assert.ok(again.status >= 400);
});

test("payment intent in flight blocks direct pending-payment cancel", async () => {
  enableEcommercePaymentsTestHarness();
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId } = await quoteAndOrder({ tenant, branch, product, customer, app });

  const intent = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  assert.equal(intent.status, 201);

  const blocked = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/cancel`)
    .set({ authorization: `Bearer ${token}` })
    .send({});
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.error?.code, "PAYMENT_IN_FLIGHT");
});

test("staff fulfilment transition to CANCELLED is blocked", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { product } = await seedCheckoutReady({ tenant, user, branch });
  const { orderId } = await placeCodOrder({ tenant, branch, customer, product });
  const accept = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/cod/accept`)
    .set(staffHeaders(user))
    .send({ expectedVersion: 1 });
  assert.equal(accept.status, 200);
  const order = await EcommerceOrder.findById(orderId).lean();
  assert.equal(order.status, EcommerceOrderStatus.PROCESSING);
  const block = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/fulfilment-transition`)
    .set(staffHeaders(user))
    .send({
      expectedVersion: order.version,
      targetStatus: EcommerceOrderStatus.CANCELLED,
    });
  assert.equal(block.status, 422);
  assert.match(String(block.body.error?.message ?? ""), /cancellation/i);
});

test("paid online request then admin approve enters REFUND_PENDING with cancellation refund source", async () => {
  enableEcommercePaymentsTestHarness();
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise } = await quoteAndOrder({ tenant, branch, product, customer, app });
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  await postCompletedWebhookHttp({
    app,
    tenantId: tenant._id,
    merchantOrderId: created.body.data.paymentIntent.merchantOrderId,
    amountPaise: totalPaise,
  });
  const paid = await EcommerceOrder.findById(orderId).lean();
  assert.equal(paid.status, EcommerceOrderStatus.PAID);

  const reqKey = createId("creq");
  const req = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/cancellation-requests`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": reqKey })
    .send({ reason: "Ordered by mistake please cancel" });
  assert.ok(req.status === 200 || req.status === 201);
  assert.equal(req.body.data.request.status, EcommerceOrderCancellationRequestStatus.PENDING_DECISION);

  const stillPaid = await EcommerceOrder.findById(orderId).lean();
  assert.equal(stillPaid.status, EcommerceOrderStatus.PAID);

  const decision = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/cancellation/decision`)
    .set(staffHeaders(user))
    .send({
      decision: "APPROVE",
      expectedVersion: req.body.data.request.version,
      stockDisposition: "STOCK_EXCEPTION",
    });
  assert.equal(decision.status, 200);
  assert.equal(decision.body.data.refundCaseCreated, true);
  assert.equal(decision.body.data.refundInitiationRequired, true);

  const after = await EcommerceOrder.findById(orderId).lean();
  assert.equal(after.status, EcommerceOrderStatus.REFUND_PENDING);
  const refund = await EcommercePaymentExceptionRefund.findOne({ orderId }).lean();
  assert.equal(refund.refundSource, EcommerceOrderRefundSource.ORDER_CANCELLATION);
  assert.notEqual(refund.status, "SUCCEEDED");
});

test("shipped order rejects customer cancellation request", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { product } = await seedCheckoutReady({ tenant, user, branch });
  const { token, orderId } = await placeCodOrder({ tenant, branch, customer, product });
  await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/cod/accept`)
    .set(staffHeaders(user))
    .send({ expectedVersion: 1 });
  let order = await EcommerceOrder.findById(orderId).lean();
  await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/fulfilment-transition`)
    .set(staffHeaders(user))
    .send({ expectedVersion: order.version, targetStatus: EcommerceOrderStatus.SHIPPED });
  order = await EcommerceOrder.findById(orderId).lean();
  assert.equal(order.status, EcommerceOrderStatus.SHIPPED);

  const req = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/cancellation-requests`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("creq") })
    .send({ reason: "Need to cancel after shipping" });
  assert.equal(req.status, 422);
  assert.equal(req.body.error?.code, "CONTACT_STORE_FOR_RETURN");
});

test("cancellation request idempotency returns same request", async () => {
  enableEcommercePaymentsTestHarness();
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise } = await quoteAndOrder({ tenant, branch, product, customer, app });
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  await postCompletedWebhookHttp({
    app,
    tenantId: tenant._id,
    merchantOrderId: created.body.data.paymentIntent.merchantOrderId,
    amountPaise: totalPaise,
  });
  const key = createId("idem-req");
  const body = { reason: "Duplicate idempotency check" };
  const first = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/cancellation-requests`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": key })
    .send(body);
  const second = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/cancellation-requests`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": key })
    .send(body);
  assert.ok(first.status === 200 || first.status === 201);
  assert.ok(second.status === 200 || second.status === 201);
  assert.equal(first.body.data.request.id, second.body.data.request.id);
  assert.equal(
    await EcommerceOrderCancellationRequest.countDocuments({ orderId }),
    1,
  );
});

test("store disabled still allows cancellation request on existing paid order", async () => {
  enableEcommercePaymentsTestHarness();
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch, app });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise } = await quoteAndOrder({ tenant, branch, product, customer, app });
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  await postCompletedWebhookHttp({
    app,
    tenantId: tenant._id,
    merchantOrderId: created.body.data.paymentIntent.merchantOrderId,
    amountPaise: totalPaise,
  });
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "operations.ecommerceEnabled": false } },
  );
  const detail = await request(app)
    .get(`/api/v1/app/shop/orders/${orderId}`)
    .set({ authorization: `Bearer ${token}` });
  assert.equal(detail.status, 200);
  const req = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/cancellation-requests`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("creq") })
    .send({ reason: "Store off but order still open" });
  assert.ok(req.status === 200 || req.status === 201);
});
