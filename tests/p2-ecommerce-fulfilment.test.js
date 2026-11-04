process.env.NODE_ENV = "test";

import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceFulfilmentMode,
  EcommerceOrderStatus,
  EcommercePaymentMethod,
  PlanTier,
  TenantRole,
  UserStatus,
  UserType,
} from "../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { createId } from "../src/lib/ids.js";
import { EcommerceOrder, EcommerceOrderEvent, OutboxEvent, Session, Tenant, User } from "../src/models/index.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import {
  disableEcommercePaymentsTestHarness,
  enableEcommercePaymentsTestHarness,
  taxReadyCatalogBody,
  taxReadyFulfilmentBody,
} from "./helpers/ecommerce-checkout-fixtures.js";
import { bearerFor, resetTestDb, seedBranch, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

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

async function seedPaidOrder({ tenant, user, branch, customer, fulfilmentMode }) {
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
      requireCourierTrackingForShipped: false,
    });
  const product = await ecommerce.createProduct({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: {
      name: "Ring",
      slug: `ring-${createId("s").slice(-6)}`,
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
  await request(app)
    .put("/api/v1/app/shop/cart")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("c") })
    .send({ lines: [{ productId: product.id, quantity: 1 }] });

  let quoteBody;
  if (fulfilmentMode === EcommerceFulfilmentMode.DELIVERY) {
    const addr = await request(app)
      .post("/api/v1/app/shop/addresses")
      .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("a") })
      .send({ line1: "Home", city: "Kottayam", state: "Kerala", pincode: "686692" });
    quoteBody = {
      fulfilmentMode: EcommerceFulfilmentMode.DELIVERY,
      addressId: addr.body.data.id,
      paymentMethod: EcommercePaymentMethod.COD,
    };
  } else {
    enableEcommercePaymentsTestHarness();
    quoteBody = {
      fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
      pickupBranchId: branch._id,
    };
  }
  const quote = await request(app)
    .post("/api/v1/app/shop/quotes")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("q") })
    .send(quoteBody);
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  const order = await request(app)
    .post("/api/v1/app/shop/orders")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("o") })
    .send({ quoteId: quote.body.data.id });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  const orderId = order.body.data.id;
  if (fulfilmentMode === EcommerceFulfilmentMode.DELIVERY) {
    const accept = await request(app)
      .post(`/api/v1/admin/ecommerce/orders/${orderId}/cod/accept`)
      .set(adminHeaders(user))
      .send({ expectedVersion: order.body.data.version, reason: "ok" });
    assert.equal(accept.status, 200);
  } else {
    await request(app)
      .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
      .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
      .send({ redirectUrl: "https://example.com/return" });
    const paid = await request(app)
      .post(`/api/v1/app/shop/orders/${orderId}/test-harness/complete-payment`)
      .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("ok") })
      .send({ outcome: "COMPLETED" });
    assert.equal(paid.status, 200);
  }
  const detail = await request(app)
    .get(`/api/v1/admin/ecommerce/orders/${orderId}`)
    .set(adminHeaders(user));
  return { orderId, version: Number(detail.body.data.version), user };
}

test("delivery: ship from paid then confirm delivery with proof atomically", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, version } = await seedPaidOrder({
    tenant,
    user,
    branch,
    customer,
    fulfilmentMode: EcommerceFulfilmentMode.DELIVERY,
  });
  const ship = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/ship`)
    .set(adminHeaders(user))
    .send({
      expectedVersion: version,
      carrierName: "BlueDart",
      trackingNumber: "BD999",
      trackingUrl: "https://example.com/t/BD999",
    });
  assert.equal(ship.status, 200);
  assert.equal(ship.body.data.status, EcommerceOrderStatus.SHIPPED);
  const confirm = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/confirm-delivery`)
    .set(adminHeaders(user, randomUUID()))
    .send({
      expectedVersion: ship.body.data.version,
      proofReference: "POD-12345",
      recipientName: "Anu Joseph",
    });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.data.status, EcommerceOrderStatus.DELIVERED);
  const outbox = await OutboxEvent.countDocuments({
    tenantId: tenant._id,
    key: `${orderId}:${EcommerceOrderStatus.DELIVERED}`,
  });
  assert.ok(outbox >= 1);
});

test("pickup: ready issues codes; staff confirm collection completes order", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, version } = await seedPaidOrder({
    tenant,
    user,
    branch,
    customer,
    fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
  });
  const ready = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/ready-for-pickup`)
    .set(adminHeaders(user))
    .send({ expectedVersion: version });
  assert.equal(ready.status, 200);
  const customerCode = String(ready.body.data.customerPickupCode ?? "");
  assert.match(customerCode, /^\d{6}$/);
  const customerGet = await request(app)
    .get(`/api/v1/app/shop/orders/${orderId}`)
    .set("authorization", `Bearer ${await customerToken({ tenant, branch, customer })}`);
  assert.equal(customerGet.status, 200);
  assert.equal(customerGet.body.data.pickupCode, customerCode);
  const collected = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/confirm-pickup-collection`)
    .set(adminHeaders(user, randomUUID()))
    .send({
      expectedVersion: ready.body.data.order.version,
      pickupCode: customerCode,
      staffHandoverConfirmed: true,
      recipientName: "Anu Joseph",
    });
  assert.equal(collected.status, 200);
  assert.equal(collected.body.data.status, EcommerceOrderStatus.DELIVERED);
  const afterCustomer = await request(app)
    .get(`/api/v1/app/shop/orders/${orderId}`)
    .set("authorization", `Bearer ${await customerToken({ tenant, branch, customer })}`);
  assert.equal(afterCustomer.body.data.status, EcommerceOrderStatus.DELIVERED);
  assert.match(String(afterCustomer.body.data.statusLabel ?? ""), /collected/i);
});

test("customer confirm-pickup with reveal code does not change fulfilment", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const { orderId, version } = await seedPaidOrder({
    tenant,
    user,
    branch,
    customer,
    fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
  });
  const ready = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/ready-for-pickup`)
    .set(adminHeaders(user))
    .send({ expectedVersion: version });
  assert.equal(ready.status, 200);
  const customerCode = ready.body.data.customerPickupCode;
  const before = await EcommerceOrder.findById(orderId).lean();
  const getOrder = await request(app)
    .get(`/api/v1/app/shop/orders/${orderId}`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(getOrder.body.data.pickupCode, customerCode);
  const ack = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/confirm-pickup`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("ack") })
    .send({ code: customerCode });
  assert.equal(ack.status, 200);
  assert.equal(ack.body.data.acknowledged, true);
  const after = await EcommerceOrder.findById(orderId).lean();
  assert.equal(after.status, EcommerceOrderStatus.READY_FOR_PICKUP);
  assert.equal(after.status, before.status);
  assert.equal(after.fulfilmentHandover?.recordedAt, undefined);
  assert.ok(after.fulfilmentHandover?.customerPickupAcknowledgedAt);
  const handoverEvents = await EcommerceOrderEvent.countDocuments({
    orderId,
    type: "PICKUP_CODE_CUSTOMER_ACKNOWLEDGED",
  });
  assert.equal(handoverEvents, 1);
  assert.equal(
    (await EcommerceOrderEvent.countDocuments({ orderId, type: "FULFILMENT_HANDOVER_RECORDED" })),
    0,
  );
});

test("pickup: staff challenge code cannot complete admin collection", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, version } = await seedPaidOrder({
    tenant,
    user,
    branch,
    customer,
    fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
  });
  const ready = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/ready-for-pickup`)
    .set(adminHeaders(user))
    .send({ expectedVersion: version });
  const reveal = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/staff-handover-challenge/reveal`)
    .set(adminHeaders(user));
  assert.equal(reveal.status, 200);
  const res = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/confirm-pickup-collection`)
    .set(adminHeaders(user))
    .send({
      expectedVersion: ready.body.data.order.version,
      pickupCode: reveal.body.data.challengeCode,
      staffHandoverConfirmed: true,
      recipientName: "Test",
    });
  assert.equal(res.status, 422);
});

test("pickup: duplicate confirm-pickup-collection is idempotent", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, version } = await seedPaidOrder({
    tenant,
    user,
    branch,
    customer,
    fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
  });
  const ready = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/ready-for-pickup`)
    .set(adminHeaders(user))
    .send({ expectedVersion: version });
  const code = ready.body.data.customerPickupCode;
  const key = randomUUID();
  const payload = {
    expectedVersion: ready.body.data.order.version,
    pickupCode: code,
    staffHandoverConfirmed: true,
    recipientName: "Test User",
  };
  const first = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/confirm-pickup-collection`)
    .set(adminHeaders(user, key))
    .send(payload);
  const second = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/confirm-pickup-collection`)
    .set(adminHeaders(user, key))
    .send(payload);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.headers["x-idempotent-replay"], "true");
  const refresh = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/confirm-pickup-collection`)
    .set(adminHeaders(user, randomUUID()))
    .send({
      ...payload,
      expectedVersion: first.body.data.version,
    });
  assert.equal(refresh.status, 200);
  assert.equal(refresh.body.data.alreadyCollected, true);
});

test("unpaid order rejects ship", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const orderId = createId("eo");
  await EcommerceOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customer._id,
    orderNumber: "UNPAID-1",
    status: EcommerceOrderStatus.PENDING_PAYMENT,
    totalPaise: 1000,
    fulfilmentMode: EcommerceFulfilmentMode.DELIVERY,
    addressSnapshot: { pincode: "686692" },
    version: 1,
  });
  const res = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/ship`)
    .set(adminHeaders(user))
    .send({ expectedVersion: 1, carrierName: "X", trackingNumber: "1" });
  assert.equal(res.status, 422);
});

test("pickup order rejects ship", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, version } = await seedPaidOrder({
    tenant,
    user,
    branch,
    customer,
    fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
  });
  const res = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/ship`)
    .set(adminHeaders(user))
    .send({ expectedVersion: version, carrierName: "X", trackingNumber: "1" });
  assert.equal(res.status, 422);
});

test("stale expectedVersion on ship returns conflict", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, version } = await seedPaidOrder({
    tenant,
    user,
    branch,
    customer,
    fulfilmentMode: EcommerceFulfilmentMode.DELIVERY,
  });
  const res = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/ship`)
    .set(adminHeaders(user))
    .send({ expectedVersion: version - 1, carrierName: "X", trackingNumber: "1" });
  assert.equal(res.status, 409);
});

test("concurrent ship: only one succeeds", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, version } = await seedPaidOrder({
    tenant,
    user,
    branch,
    customer,
    fulfilmentMode: EcommerceFulfilmentMode.DELIVERY,
  });
  const body = { expectedVersion: version, carrierName: "D", trackingNumber: "R1" };
  const [a, b] = await Promise.all([
    request(app).post(`/api/v1/admin/ecommerce/orders/${orderId}/ship`).set(adminHeaders(user, randomUUID())).send(body),
    request(app).post(`/api/v1/admin/ecommerce/orders/${orderId}/ship`).set(adminHeaders(user, randomUUID())).send(body),
  ]);
  const ok = [a.status, b.status].filter((s) => s === 200);
  assert.equal(ok.length, 1);
});

test("duplicate confirm-delivery idempotency replays", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, version } = await seedPaidOrder({
    tenant,
    user,
    branch,
    customer,
    fulfilmentMode: EcommerceFulfilmentMode.DELIVERY,
  });
  const ship = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/ship`)
    .set(adminHeaders(user))
    .send({ expectedVersion: version, carrierName: "D", trackingNumber: "T1" });
  const key = randomUUID();
  const payload = {
    expectedVersion: ship.body.data.version,
    proofReference: "POD-DUP",
    recipientName: "Test User",
  };
  const first = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/confirm-delivery`)
    .set(adminHeaders(user, key))
    .send(payload);
  const second = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/confirm-delivery`)
    .set(adminHeaders(user, key))
    .send(payload);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.headers["x-idempotent-replay"], "true");
});

test("admin reissue pickup code after expiry resets attempts and invalidates prior code", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, version } = await seedPaidOrder({
    tenant,
    user,
    branch,
    customer,
    fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
  });
  const ready = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/ready-for-pickup`)
    .set(adminHeaders(user))
    .send({ expectedVersion: version });
  assert.equal(ready.status, 200);
  const oldCode = ready.body.data.customerPickupCode;
  await EcommerceOrder.updateOne(
    { _id: orderId },
    {
      $set: {
        "fulfilmentHandover.pickupCodeExpiresAt": new Date(Date.now() - 60_000),
        "fulfilmentHandover.pickupCodeFailedAttempts": 5,
      },
    },
  );
  const reissue = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/pickup-code`)
    .set(adminHeaders(user))
    .send({ expectedVersion: ready.body.data.order.version });
  assert.equal(reissue.status, 200);
  assert.ok(reissue.body.data.pickupCode);
  assert.notEqual(reissue.body.data.pickupCode, oldCode);
  const row = await EcommerceOrder.findById(orderId).lean();
  assert.equal(row.fulfilmentHandover.pickupCodeFailedAttempts, 0);
  assert.ok(new Date(row.fulfilmentHandover.pickupCodeExpiresAt).getTime() > Date.now());
  const collect = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/confirm-pickup-collection`)
    .set(adminHeaders(user))
    .send({
      expectedVersion: reissue.body.data.version,
      pickupCode: reissue.body.data.pickupCode,
      staffHandoverConfirmed: true,
      recipientName: "Test",
    });
  assert.equal(collect.status, 200);
});

test("expired customer pickup code blocks collection", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, version } = await seedPaidOrder({
    tenant,
    user,
    branch,
    customer,
    fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
  });
  const ready = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/ready-for-pickup`)
    .set(adminHeaders(user))
    .send({ expectedVersion: version });
  await EcommerceOrder.updateOne(
    { _id: orderId },
    { $set: { "fulfilmentHandover.pickupCodeExpiresAt": new Date(Date.now() - 60_000) } },
  );
  const res = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/confirm-pickup-collection`)
    .set(adminHeaders(user))
    .send({
      expectedVersion: ready.body.data.order.version,
      pickupCode: ready.body.data.customerPickupCode,
      staffHandoverConfirmed: true,
      recipientName: "Test",
    });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, "PICKUP_CODE_EXPIRED");
});

test("wrong pickup code returns invalid and counts attempts", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, version } = await seedPaidOrder({
    tenant,
    user,
    branch,
    customer,
    fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
  });
  const ready = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/ready-for-pickup`)
    .set(adminHeaders(user))
    .send({ expectedVersion: version });
  const res = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/confirm-pickup-collection`)
    .set(adminHeaders(user))
    .send({
      expectedVersion: ready.body.data.order.version,
      pickupCode: "000000",
      staffHandoverConfirmed: true,
      recipientName: "Test",
    });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, "PICKUP_CODE_INVALID");
  const row = await EcommerceOrder.findById(orderId).lean();
  assert.equal(row.fulfilmentHandover.pickupCodeFailedAttempts, 1);
});

test("branch manager cannot ship order for another branch pickup", async () => {
  const { tenant, branch: branchA, user } = await seedTenantUser({});
  const branchB = await seedBranch({ tenantId: tenant._id, code: "BRB", name: "Branch B" });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branchB._id });
  const { orderId, version } = await seedPaidOrder({
    tenant,
    user,
    branch: branchB,
    customer,
    fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
  });
  const manager = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branchA._id,
    role: TenantRole.BRANCH_MANAGER,
    name: "Mgr",
    mobile: "+918811188881",
    passwordHash: await argon2.hash("1234", {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    }),
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_MANAGER] ?? [],
  });
  const sess = await Session.create({
    _id: createId("session"),
    userId: manager._id,
    tenantId: tenant._id,
    deviceId: "m",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  manager.$locals = { testSessionId: sess._id };
  const res = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/ready-for-pickup`)
    .set(adminHeaders(manager))
    .send({ expectedVersion: version });
  assert.equal(res.status, 403);
});

test("legacy PROCESSING order can still ship via compound endpoint", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId } = await seedPaidOrder({
    tenant,
    user,
    branch,
    customer,
    fulfilmentMode: EcommerceFulfilmentMode.DELIVERY,
  });
  await EcommerceOrder.updateOne({ _id: orderId }, { $set: { status: EcommerceOrderStatus.PROCESSING } });
  const detail = await request(app)
    .get(`/api/v1/admin/ecommerce/orders/${orderId}`)
    .set(adminHeaders(user));
  const ship = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/ship`)
    .set(adminHeaders(user))
    .send({
      expectedVersion: detail.body.data.version,
      carrierName: "D",
      trackingNumber: "LEGACY",
    });
  assert.equal(ship.status, 200);
});
