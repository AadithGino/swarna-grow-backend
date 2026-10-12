import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceCancellationStockDisposition,
  EcommerceFulfilmentMode,
  EcommerceOrderStatus,
  EcommercePaymentMethod,
  EcommercePriceMode,
  EcommerceStockPolicy,
  PlanTier,
  TenantRole,
} from "../src/constants/enums.js";
import {
  EcommerceInventory,
  EcommerceOrder,
  EcommerceStockReservation,
  Tenant,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { orderCancellationStockDispositionRequired } from "../src/lib/ecommerce-order-cancellation-stock.js";
import { applyCancellationStockDispositionOnce } from "../src/lib/ecommerce-order-stock-restock.js";
import { withTransaction } from "../src/lib/transaction.js";
import { enableEcommercePaymentsTestHarness } from "./helpers/ecommerce-checkout-fixtures.js";
import {
  postCompletedWebhookHttp,
  quoteAndOrder,
  seedReady,
} from "./helpers/ecommerce-payment-test-flow.js";
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import {
  disableEcommercePaymentsTestHarness,
  taxReadyCatalogBody,
  taxReadyFulfilmentBody,
} from "./helpers/ecommerce-checkout-fixtures.js";

const app = createApp();

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
  enableEcommercePaymentsTestHarness();
});

function staffHeaders(user, key = createId("idem")) {
  return {
    authorization: `Bearer ${bearerFor(user, ROLE_PERMISSIONS[TenantRole.TENANT_ADMIN])}`,
    "x-idempotency-key": key,
  };
}

async function paidOnlineOrder({
  tenant,
  user,
  branch,
  qty = 10,
  product = null,
  adminHeaders = null,
  customer = null,
}) {
  const seeded = product
    ? { product, adminHeaders: adminHeaders ?? staffHeaders(user) }
    : await seedReady({ tenant, user, branch, app, qty });
  const resolvedProduct = seeded.product;
  const resolvedAdminHeaders = seeded.adminHeaders;
  const resolvedCustomer =
    customer ?? (await seedCustomer({ tenantId: tenant._id, branchId: branch._id }));
  const { token, orderId, totalPaise, productId } = await quoteAndOrder({
    tenant,
    branch,
    product: resolvedProduct,
    customer: resolvedCustomer,
    app,
  });
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  await postCompletedWebhookHttp({
    app,
    tenantId: tenant._id,
    merchantOrderId: created.body.data.paymentIntent.merchantOrderId,
    amountPaise: totalPaise,
    transactionId: createId("txn"),
  });
  const paid = await EcommerceOrder.findById(orderId).lean();
  assert.equal(paid.status, EcommerceOrderStatus.PAID);
  assert.ok(paid.stockConsumptionEvidence?.length >= 1);
  assert.equal(paid.stockConsumptionEvidence[0].quantityDeducted, 1);
  return {
    token,
    orderId,
    productId,
    product: resolvedProduct,
    customer: resolvedCustomer,
    adminHeaders: resolvedAdminHeaders,
  };
}

test("PAID tracked SKU still requires disposition after policy flips to MADE_TO_ORDER", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { orderId, productId, adminHeaders } = await paidOnlineOrder({ tenant, user, branch });

  const inv = await EcommerceInventory.findOne({ tenantId: tenant._id, productId }).lean();
  const patch = await request(app)
    .patch(`/api/v1/admin/ecommerce/inventory/${productId}`)
    .set(adminHeaders)
    .send({ stockPolicy: EcommerceStockPolicy.MADE_TO_ORDER, expectedVersion: inv.version });
  assert.equal(patch.status, 200);

  const order = await EcommerceOrder.findById(orderId).lean();
  assert.equal(await orderCancellationStockDispositionRequired(order, null), true);
});

test("RESTOCK_CONFIRMED restores deducted quantity once including replay", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { orderId, productId } = await paidOnlineOrder({ tenant, user, branch });
  const before = (await EcommerceInventory.findOne({ tenantId: tenant._id, productId }).lean())
    .quantityOnHand;

  await withTransaction(async (session) => {
    const r1 = await applyCancellationStockDispositionOnce({
      tenantId: tenant._id,
      orderId,
      disposition: EcommerceCancellationStockDisposition.RESTOCK_CONFIRMED,
      actorUserId: user._id,
      idempotencyKey: "restock-once",
      session,
    });
    assert.equal(r1.kind, "RESTOCKED");
    const r2 = await applyCancellationStockDispositionOnce({
      tenantId: tenant._id,
      orderId,
      disposition: EcommerceCancellationStockDisposition.RESTOCK_CONFIRMED,
      actorUserId: user._id,
      idempotencyKey: "restock-once",
      session,
    });
    assert.equal(r2.kind, "ALREADY_APPLIED");
  });

  const after = (await EcommerceInventory.findOne({ tenantId: tenant._id, productId }).lean()).quantityOnHand;
  assert.equal(after, before + 1);
});

test("MTO line with zero deducted does not require restock after policy flips to QUANTITY_TRACKED", async () => {
  const { tenant } = await seedTenantUser({});
  const productId = createId("eprd");
  const order = {
    _id: createId("eord"),
    tenantId: tenant._id,
    status: EcommerceOrderStatus.PAID,
    paidAt: new Date(),
    stockConsumptionEvidence: [
      {
        productId,
        quantityDeducted: 0,
        inventoryId: null,
        stockPolicyAtConsumption: EcommerceStockPolicy.MADE_TO_ORDER,
        consumedAt: new Date(),
      },
    ],
    lines: [{ productId, quantity: 1 }],
  };
  assert.equal(await orderCancellationStockDispositionRequired(order, null), false);
});

test("mixed tracked and made-to-order lines require disposition only for tracked deduction", async () => {
  const { tenant } = await seedTenantUser({});
  const trackedId = createId("eprd1");
  const mtoId = createId("eprd2");
  const order = {
    tenantId: tenant._id,
    status: EcommerceOrderStatus.PAID,
    stockConsumptionEvidence: [
      {
        productId: trackedId,
        quantityDeducted: 2,
        stockPolicyAtConsumption: EcommerceStockPolicy.QUANTITY_TRACKED,
      },
      {
        productId: mtoId,
        quantityDeducted: 0,
        stockPolicyAtConsumption: EcommerceStockPolicy.MADE_TO_ORDER,
      },
    ],
    lines: [
      { productId: trackedId, quantity: 2 },
      { productId: mtoId, quantity: 1 },
    ],
  };
  assert.equal(await orderCancellationStockDispositionRequired(order, null), true);
});

test("RESTOCK_CONFIRMED fails closed when inventory row missing", async () => {
  const { tenant, user } = await seedTenantUser({});
  const productId = createId("eprd");
  const orderId = createId("eord");
  await EcommerceOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: createId("cust"),
    orderNumber: "ORD-TEST-1",
    status: EcommerceOrderStatus.PAID,
    version: 1,
    stockConsumptionEvidence: [
      {
        productId,
        quantityDeducted: 1,
        inventoryId: createId("einv"),
        stockPolicyAtConsumption: EcommerceStockPolicy.QUANTITY_TRACKED,
        consumedAt: new Date(),
      },
    ],
    lines: [{ productId, quantity: 1 }],
  });

  await assert.rejects(
    () =>
      withTransaction((session) =>
        applyCancellationStockDispositionOnce({
          tenantId: tenant._id,
          orderId,
          disposition: EcommerceCancellationStockDisposition.RESTOCK_CONFIRMED,
          actorUserId: user._id,
          session,
        }),
      ),
    (err) => err.code === "INVENTORY_NOT_FOUND",
  );
});

test("legacy paid order with stockConsumedAt but no evidence is uncertain", async () => {
  const { tenant } = await seedTenantUser({});
  const productId = createId("eprd");
  const orderId = createId("eord");
  await EcommerceOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: createId("cust"),
    orderNumber: "ORD-LEG-1",
    status: EcommerceOrderStatus.PAID,
    stockConsumedAt: new Date(),
    version: 1,
    lines: [{ productId, quantity: 1 }],
  });
  const order = await EcommerceOrder.findById(orderId).lean();
  assert.equal(await orderCancellationStockDispositionRequired(order, null), true);
  await assert.rejects(
    () =>
      withTransaction((session) =>
        applyCancellationStockDispositionOnce({
          tenantId: tenant._id,
          orderId,
          disposition: EcommerceCancellationStockDisposition.RESTOCK_CONFIRMED,
          actorUserId: createId("usr"),
          session,
        }),
      ),
    (err) => err.code === "STOCK_RESTOCK_UNCERTAIN",
  );
});

test("COD accept records consumption evidence; cancel path still needs disposition when tracked", async () => {
  disableEcommercePaymentsTestHarness();
  const { tenant, user, branch } = await seedTenantUser({});
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
  await ecommerce.putTaxSettings({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: taxReadyCatalogBody(),
  });
  await request(app)
    .put("/api/v1/admin/ecommerce/fulfilment-settings")
    .set(staffHeaders(user))
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
      name: "CodRing",
      slug: `cod-${createId("s").slice(-6)}`,
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
    .patch(`/api/v1/admin/ecommerce/inventory/${product.id}`)
    .set(staffHeaders(user))
    .send({ stockPolicy: EcommerceStockPolicy.QUANTITY_TRACKED, quantityOnHand: 5 });

  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
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
  const token = signAccessToken({
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
  const placed = await request(app)
    .post("/api/v1/app/shop/orders")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("o") })
    .send({ quoteId: quote.body.data.id });
  const orderId = placed.body.data.id;
  const accept = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/cod/accept`)
    .set(staffHeaders(user))
    .send({ expectedVersion: placed.body.data.version });
  assert.equal(accept.status, 200);
  const afterAccept = await EcommerceOrder.findById(orderId).lean();
  assert.equal(afterAccept.stockConsumptionEvidence[0].quantityDeducted, 1);
  assert.equal(await orderCancellationStockDispositionRequired(afterAccept, null), true);
});

test("cannot switch inventory to MADE_TO_ORDER while active reservations exist", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product, adminHeaders } = await seedReady({ tenant, user, branch, app, qty: 3 });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId } = await quoteAndOrder({ tenant, branch, product, customer, app });
  const active = await EcommerceStockReservation.countDocuments({
    tenantId: tenant._id,
    orderId,
    releasedAt: null,
  });
  assert.ok(active >= 1);
  const inv = await EcommerceInventory.findOne({ tenantId: tenant._id, productId: product.id }).lean();
  const blocked = await request(app)
    .patch(`/api/v1/admin/ecommerce/inventory/${product.id}`)
    .set(adminHeaders)
    .send({
      stockPolicy: EcommerceStockPolicy.MADE_TO_ORDER,
      expectedVersion: inv.version,
    });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.error?.code, "INVENTORY_POLICY_CHANGE_BLOCKED");
});

test("concurrent cancellation idempotency: same key same order yields one row", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { token, orderId } = await paidOnlineOrder({ tenant, user, branch });
  const key = createId("idem-concurrent");
  const body = { reason: "Concurrent same order idempotency" };
  const [a, b] = await Promise.all([
    request(app)
      .post(`/api/v1/app/shop/orders/${orderId}/cancellation-requests`)
      .set({ authorization: `Bearer ${token}`, "x-idempotency-key": key })
      .send(body),
    request(app)
      .post(`/api/v1/app/shop/orders/${orderId}/cancellation-requests`)
      .set({ authorization: `Bearer ${token}`, "x-idempotency-key": key })
      .send(body),
  ]);
  const ok = [a, b].filter((r) => r.status === 200 || r.status === 201);
  assert.ok(ok.length >= 1);
  if (ok.length === 2) {
    assert.equal(ok[0].body.data.request.id, ok[1].body.data.request.id);
  }
  const { EcommerceOrderCancellationRequest } = await import("../src/models/index.js");
  assert.equal(await EcommerceOrderCancellationRequest.countDocuments({ tenantId: tenant._id, idempotencyKey: key }), 1);
});

test("concurrent cancellation idempotency: same key different orders → one 409", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const a = await paidOnlineOrder({ tenant, user, branch, qty: 20 });
  const customer2 = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+918877665544",
  });
  const b = await paidOnlineOrder({
    tenant,
    user,
    branch,
    product: a.product,
    adminHeaders: a.adminHeaders,
    customer: customer2,
  });
  const key = createId("idem-race");
  const body = { reason: "Race different orders same key" };
  const first = await request(app)
    .post(`/api/v1/app/shop/orders/${a.orderId}/cancellation-requests`)
    .set({ authorization: `Bearer ${a.token}`, "x-idempotency-key": key })
    .send(body);
  const second = await request(app)
    .post(`/api/v1/app/shop/orders/${b.orderId}/cancellation-requests`)
    .set({ authorization: `Bearer ${b.token}`, "x-idempotency-key": key })
    .send(body);
  const ok = (r) => r.status === 200 || r.status === 201;
  assert.ok(ok(first) !== ok(second));
  const conflict = first.status === 409 ? first : second;
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error?.code, "IDEMPOTENCY_KEY_REUSED");
});

test("same idempotency key different body returns 409", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { token, orderId } = await paidOnlineOrder({ tenant, user, branch });
  const key = createId("idem-body");
  const first = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/cancellation-requests`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": key })
    .send({ reason: "First body for idempotency key" });
  assert.ok(first.status === 200 || first.status === 201);
  const second = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/cancellation-requests`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": key })
    .send({ reason: "Different body same key now" });
  assert.equal(second.status, 409);
  assert.equal(second.body.error?.code, "IDEMPOTENCY_KEY_REUSED");
});

test("different tenants may reuse the same cancellation idempotency key", async () => {
  const a = await seedTenantUser({});
  const b = await seedTenantUser({ tenantCode: "T2SHOP" });
  const orderA = await paidOnlineOrder({ tenant: a.tenant, user: a.user, branch: a.branch });
  enableEcommercePaymentsTestHarness();
  const orderB = await paidOnlineOrder({ tenant: b.tenant, user: b.user, branch: b.branch });
  const key = "shared-tenant-independent-key";
  const body = { reason: "Tenant scoped idempotency keys" };
  const ra = await request(app)
    .post(`/api/v1/app/shop/orders/${orderA.orderId}/cancellation-requests`)
    .set({ authorization: `Bearer ${orderA.token}`, "x-idempotency-key": key })
    .send(body);
  const rb = await request(app)
    .post(`/api/v1/app/shop/orders/${orderB.orderId}/cancellation-requests`)
    .set({ authorization: `Bearer ${orderB.token}`, "x-idempotency-key": key })
    .send(body);
  assert.ok(ra.status === 200 || ra.status === 201);
  assert.ok(rb.status === 200 || rb.status === 201);
  assert.notEqual(ra.body.data.request.id, rb.body.data.request.id);
});
