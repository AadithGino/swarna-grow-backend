process.env.NODE_ENV = "test";

import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceFulfilmentMode,
  EcommerceOrderReturnKind,
  TenantRole,
  UserStatus,
  UserType,
} from "../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { createId } from "../src/lib/ids.js";
import { EcommerceOrder, EcommerceOrderReturnRequest, Session, User } from "../src/models/index.js";
import {
  disableEcommercePaymentsTestHarness,
  enableEcommercePaymentsTestHarness,
  taxReadyCatalogBody,
  taxReadyFulfilmentBody,
} from "./helpers/ecommerce-checkout-fixtures.js";
import { bearerFor, resetTestDb, seedBranch, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import * as ecommerce from "../src/services/ecommerce.service.js";

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
  const { PlanTier } = await import("../src/constants/enums.js");
  await tenant.updateOne({
    $set: {
      "subscription.planFeaturesSnapshot": { ecommerce: true },
      "subscription.tier": PlanTier.PRO,
      "operations.ecommerceEnabled": true,
    },
  });
}

async function seedBranchManager({ tenant, branch, mobile = "+919666655544" }) {
  const user = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branch._id,
    role: TenantRole.BRANCH_MANAGER,
    name: "Branch Manager",
    mobile,
    passwordHash: await argon2.hash("1234", { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_MANAGER] ?? [],
  });
  const session = await Session.create({
    _id: createId("session"),
    userId: user._id,
    tenantId: tenant._id,
    deviceId: "test-device",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  user.$locals = { testSessionId: session._id };
  return user;
}

async function paidPickupAtBranch({ tenant, owner, pickupBranch, customerBranch, customer }) {
  await enableStore(tenant);
  await ecommerce.putTaxSettings({
    auth: { tenantId: tenant._id, id: owner._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: taxReadyCatalogBody(),
  });
  await request(app)
    .put("/api/v1/admin/ecommerce/fulfilment-settings")
    .set(adminHeaders(owner))
    .send({ ...taxReadyFulfilmentBody(pickupBranch._id), deliveryEnabled: true, serviceablePincodes: ["686692"] });
  const product = await ecommerce.createProduct({
    auth: { tenantId: tenant._id, id: owner._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: {
      name: "Chain",
      slug: `chain-${createId("s").slice(-6)}`,
      priceMode: "FIXED",
      fixedPricing: { basePricePaise: 40_000 },
      taxClassification: "GST_3",
    },
  });
  await ecommerce.publishProduct({
    auth: { tenantId: tenant._id, id: owner._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    params: { productId: product.id },
    body: { expectedVersion: 1 },
  });
  const { signAccessToken } = await import("../src/services/token.service.js");
  const customerSession = await Session.create({
    _id: createId("session"),
    customerId: customer._id,
    tenantId: tenant._id,
    deviceId: "dev",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "android",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const token = signAccessToken({
    id: customer._id,
    type: "CUSTOMER",
    tenantId: tenant._id,
    branchId: customerBranch._id,
    role: "CUSTOMER",
    permissions: [],
    deviceId: "dev",
    securityVersion: 0,
    sessionId: customerSession._id,
  });
  enableEcommercePaymentsTestHarness();
  await request(app)
    .put("/api/v1/app/shop/cart")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("c") })
    .send({ lines: [{ productId: product.id, quantity: 1 }] });
  const quote = await request(app)
    .post("/api/v1/app/shop/quotes")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("q") })
    .send({
      fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
      pickupBranchId: pickupBranch._id,
    });
  const order = await request(app)
    .post("/api/v1/app/shop/orders")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("o") })
    .send({ quoteId: quote.body.data.id });
  await request(app)
    .post(`/api/v1/app/shop/orders/${order.body.data.id}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  await request(app)
    .post(`/api/v1/app/shop/orders/${order.body.data.id}/test-harness/complete-payment`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("ok") })
    .send({ outcome: "COMPLETED" });
  const detail = await request(app)
    .get(`/api/v1/admin/ecommerce/orders/${order.body.data.id}`)
    .set(adminHeaders(owner));
  return { orderId: order.body.data.id, version: Number(detail.body.data.version) };
}

test("branch manager cannot read or mutate another branch pickup order", async () => {
  const { tenant, branch: branchA, user: owner } = await seedTenantUser({});
  const branchB = await seedBranch({ tenantId: tenant._id, code: "BRB", name: "Branch B" });
  const customerB = await seedCustomer({ tenantId: tenant._id, branchId: branchB._id, mobile: "+919800000301" });
  const managerA = await seedBranchManager({ tenant, branch: branchA });
  const { orderId, version } = await paidPickupAtBranch({
    tenant,
    owner,
    pickupBranch: branchB,
    customerBranch: branchB,
    customer: customerB,
  });

  const before = await EcommerceOrder.findById(orderId).lean();
  const read = await request(app)
    .get(`/api/v1/admin/ecommerce/orders/${orderId}`)
    .set(adminHeaders(managerA));
  assert.equal(read.status, 403, JSON.stringify(read.body));

  const pickup = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/pickup-code`)
    .set(adminHeaders(managerA, randomUUID()))
    .send({ expectedVersion: version });
  assert.equal(pickup.status, 403, JSON.stringify(pickup.body));

  const after = await EcommerceOrder.findById(orderId).lean();
  assert.equal(after.version, before.version);
  assert.equal(after.fulfilmentHandover?.pickupCodeHash ?? null, before.fulfilmentHandover?.pickupCodeHash ?? null);

  const ownerRead = await request(app)
    .get(`/api/v1/admin/ecommerce/orders/${orderId}`)
    .set(adminHeaders(owner));
  assert.equal(ownerRead.status, 200);
});

test("branch manager cannot approve return for another branch order", async () => {
  const { tenant, branch: branchA } = await seedTenantUser({});
  const branchB = await seedBranch({ tenantId: tenant._id, code: "BRB2", name: "Branch B2" });
  const customerB = await seedCustomer({ tenantId: tenant._id, branchId: branchB._id, mobile: "+919800000302" });
  const managerA = await seedBranchManager({ tenant, branch: branchA });
  const orderId = createId("eord");
  const returnId = createId("eret");
  await EcommerceOrder.collection.insertOne({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customerB._id,
    orderNumber: "ORD-BR-1",
    status: "DELIVERED",
    fulfilmentMode: EcommerceFulfilmentMode.DELIVERY,
    paymentMethod: "ONLINE",
    version: 3,
    lines: [],
  });
  await EcommerceOrderReturnRequest.collection.insertOne({
    _id: returnId,
    tenantId: tenant._id,
    orderId,
    customerId: customerB._id,
    kind: EcommerceOrderReturnKind.RETURN,
    status: "PENDING_REVIEW",
    reason: "Wrong size",
    version: 1,
  });

  const decide = await request(app)
    .post(`/api/v1/admin/ecommerce/return-requests/${returnId}/decision`)
    .set(adminHeaders(managerA, randomUUID()))
    .send({ decision: "APPROVE", expectedVersion: 1, decisionReason: "ok" });
  assert.equal(decide.status, 403, JSON.stringify(decide.body));

  const row = await EcommerceOrderReturnRequest.findById(returnId).lean();
  assert.equal(row.status, "PENDING_REVIEW");
  assert.equal(row.version, 1);
});
