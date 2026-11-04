process.env.NODE_ENV = "test";

import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceCourierCodCollectionStatus,
  EcommerceCourierCodRemittanceStatus,
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
import {
  EcommerceCodRemittanceBatch,
  EcommerceOrder,
  Session,
  Tenant,
  User,
} from "../src/models/index.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import {
  disableEcommercePaymentsTestHarness,
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

async function setupCodStore(tenant, user, branch) {
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
}

async function seedCodOrderProcessing({ tenant, user, branch, customer, storeReady = false }) {
  if (!storeReady) {
    await setupCodStore(tenant, user, branch);
  }
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
  const orderId = order.body.data.id;
  const accept = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/cod/accept`)
    .set(adminHeaders(user))
    .send({ expectedVersion: order.body.data.version });
  assert.equal(accept.status, 200);
  assert.equal(accept.body.data.status, EcommerceOrderStatus.PROCESSING);
  return { orderId, version: accept.body.data.version, token, totalPaise: accept.body.data.totalPaise };
}

async function shipAndDeliverCollected({ user, orderId, version, collectionRef }) {
  const ship = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/ship`)
    .set(adminHeaders(user))
    .send({ expectedVersion: version, carrierName: "Delhivery", trackingNumber: createId("t") });
  assert.equal(ship.status, 200);
  const confirm = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/confirm-delivery`)
    .set(adminHeaders(user, randomUUID()))
    .send({
      expectedVersion: ship.body.data.version,
      proofReference: "POD-AUTO",
      recipientName: "Customer",
      courierCollectionReference: collectionRef ?? `REF-${orderId.slice(-8)}`,
    });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.data.courierCod.collectionStatus, EcommerceCourierCodCollectionStatus.CONFIRMED);
  return confirm.body.data;
}

function rupeesFromPaise(paise) {
  return (paise / 100).toFixed(2);
}

test("COD accept then ship via compound ship endpoint", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, version } = await seedCodOrderProcessing({ tenant, user, branch, customer });
  const ship = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/ship`)
    .set(adminHeaders(user))
    .send({ expectedVersion: version, carrierName: "Delhivery", trackingNumber: "DLV-1" });
  assert.equal(ship.status, 200);
  assert.equal(ship.body.data.status, EcommerceOrderStatus.SHIPPED);
});

test("confirm delivery with courier collection is atomic for COD", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, version, token } = await seedCodOrderProcessing({ tenant, user, branch, customer });
  const ship = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/ship`)
    .set(adminHeaders(user))
    .send({ expectedVersion: version, carrierName: "Delhivery", trackingNumber: "DLV-2" });
  const key = randomUUID();
  const confirm = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/confirm-delivery`)
    .set(adminHeaders(user, key))
    .send({
      expectedVersion: ship.body.data.version,
      proofReference: "POD-ATOMIC",
      recipientName: "Customer",
      courierCollectionReference: "COURIER-RCPT-1",
      courierCollectionEvidenceNote: "Courier handed cash at door",
    });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.data.status, EcommerceOrderStatus.DELIVERED);
  assert.equal(confirm.body.data.courierCod.collectionStatus, EcommerceCourierCodCollectionStatus.CONFIRMED);
  const customerView = await request(app)
    .get(`/api/v1/app/shop/orders/${orderId}`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(customerView.body.data.codPaymentEvidence?.collectionConfirmed, true);
});

test("confirm delivery without courier reference leaves payment unconfirmed", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, version, token } = await seedCodOrderProcessing({ tenant, user, branch, customer });
  const ship = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/ship`)
    .set(adminHeaders(user))
    .send({ expectedVersion: version, carrierName: "Delhivery", trackingNumber: "DLV-3" });
  const confirm = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/confirm-delivery`)
    .set(adminHeaders(user, randomUUID()))
    .send({
      expectedVersion: ship.body.data.version,
      proofReference: "POD-NO-COD",
      recipientName: "Customer",
    });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.data.status, EcommerceOrderStatus.DELIVERED);
  assert.equal(confirm.body.data.courierCod.collectionStatus, EcommerceCourierCodCollectionStatus.PENDING);
  const customerView = await request(app)
    .get(`/api/v1/app/shop/orders/${orderId}`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(customerView.body.data.codPaymentEvidence?.collectionConfirmed, false);
});

test("record money received creates batch, lines and reconciles in rupees", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await setupCodStore(tenant, user, branch);
  const ctx1 = await seedCodOrderProcessing({ tenant, user, branch, customer, storeReady: true });
  const ctx2 = await seedCodOrderProcessing({ tenant, user, branch, customer, storeReady: true });
  await shipAndDeliverCollected({ user, orderId: ctx1.orderId, version: ctx1.version });
  await shipAndDeliverCollected({ user, orderId: ctx2.orderId, version: ctx2.version });
  const totalFeesPaise = 500;
  const netPaise = ctx1.totalPaise + ctx2.totalPaise - totalFeesPaise;
  const res = await request(app)
    .post("/api/v1/admin/ecommerce/courier-cod/record-money-received")
    .set(adminHeaders(user, createId("money")))
    .send({
      orderIds: [ctx1.orderId, ctx2.orderId],
      bankCreditReference: "NEFT-RECORD-1",
      bankCreditRupees: rupeesFromPaise(netPaise),
      totalCourierFeeRupees: rupeesFromPaise(totalFeesPaise),
      bankCreditedAt: new Date().toISOString(),
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.reconciliation.outcomeLabel, "Matched");
  assert.equal(res.body.data.batch.status, "BANK_RECONCILED");
  assert.equal(res.body.data.lines.length, 2);
  const o1 = await EcommerceOrder.findById(ctx1.orderId).lean();
  assert.equal(o1.courierCod.remittanceStatus, EcommerceCourierCodRemittanceStatus.BANK_RECONCILED);
});

test("record money received rejects duplicate bank credit reference", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const ctx1 = await seedCodOrderProcessing({ tenant, user, branch, customer });
  const ctx2 = await seedCodOrderProcessing({ tenant, user, branch, customer, storeReady: true });
  await shipAndDeliverCollected({ user, orderId: ctx1.orderId, version: ctx1.version });
  await shipAndDeliverCollected({ user, orderId: ctx2.orderId, version: ctx2.version });
  const bankRef = "NEFT-DUP-REF";
  const net1 = ctx1.totalPaise;
  const first = await request(app)
    .post("/api/v1/admin/ecommerce/courier-cod/record-money-received")
    .set(adminHeaders(user, createId("m1")))
    .send({
      orderIds: [ctx1.orderId],
      bankCreditReference: bankRef,
      bankCreditRupees: rupeesFromPaise(net1),
      totalCourierFeeRupees: "0",
    });
  assert.equal(first.status, 200);
  const net2 = ctx2.totalPaise;
  const second = await request(app)
    .post("/api/v1/admin/ecommerce/courier-cod/record-money-received")
    .set(adminHeaders(user, createId("m2")))
    .send({
      orderIds: [ctx2.orderId],
      bankCreditReference: bankRef,
      bankCreditRupees: rupeesFromPaise(net2),
      totalCourierFeeRupees: "0",
    });
  assert.equal(second.status, 409);
  assert.match(String(second.body.message ?? second.body.error?.message ?? ""), /bank credit/i);
});

test("record money received concurrent allocation allows only one batch for an order", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const ctx = await seedCodOrderProcessing({ tenant, user, branch, customer });
  await shipAndDeliverCollected({ user, orderId: ctx.orderId, version: ctx.version });
  const body = {
    orderIds: [ctx.orderId],
    bankCreditReference: "NEFT-RACE",
    bankCreditRupees: rupeesFromPaise(ctx.totalPaise),
    totalCourierFeeRupees: "0",
  };
  const [a, b] = await Promise.all([
    request(app)
      .post("/api/v1/admin/ecommerce/courier-cod/record-money-received")
      .set(adminHeaders(user, createId("race-a")))
      .send(body),
    request(app)
      .post("/api/v1/admin/ecommerce/courier-cod/record-money-received")
      .set(adminHeaders(user, createId("race-b")))
      .send(body),
  ]);
  const statuses = [a.status, b.status];
  assert.equal(statuses.filter((s) => s === 200).length, 1, `expected one success, got ${statuses.join(",")}`);
  assert.equal(
    statuses.filter((s) => s === 409 || s === 422).length,
    1,
    `expected one conflict, got ${statuses.join(",")}`,
  );
});

test("record money received rejects invalid rupee precision and excessive fees", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const ctx = await seedCodOrderProcessing({ tenant, user, branch, customer });
  await shipAndDeliverCollected({ user, orderId: ctx.orderId, version: ctx.version });
  const badPrecision = await request(app)
    .post("/api/v1/admin/ecommerce/courier-cod/record-money-received")
    .set(adminHeaders(user, createId("bad-dec")))
    .send({
      orderIds: [ctx.orderId],
      bankCreditReference: "NEFT-BAD",
      bankCreditRupees: "100.999",
      totalCourierFeeRupees: "0",
    });
  assert.equal(badPrecision.status, 400);
  const badFee = await request(app)
    .post("/api/v1/admin/ecommerce/courier-cod/record-money-received")
    .set(adminHeaders(user, createId("bad-fee")))
    .send({
      orderIds: [ctx.orderId],
      bankCreditReference: "NEFT-BAD-FEE",
      bankCreditRupees: rupeesFromPaise(ctx.totalPaise),
      totalCourierFeeRupees: rupeesFromPaise(ctx.totalPaise + 100),
    });
  assert.equal(badFee.status, 422);
});

test("record money received short payment marks discrepancy", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const ctx = await seedCodOrderProcessing({ tenant, user, branch, customer });
  await shipAndDeliverCollected({ user, orderId: ctx.orderId, version: ctx.version });
  const shortNet = ctx.totalPaise - 100;
  const res = await request(app)
    .post("/api/v1/admin/ecommerce/courier-cod/record-money-received")
    .set(adminHeaders(user, createId("short")))
    .send({
      orderIds: [ctx.orderId],
      bankCreditReference: "NEFT-SHORT",
      bankCreditRupees: rupeesFromPaise(shortNet),
      totalCourierFeeRupees: "0",
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.reconciliation.outcomeLabel, "Short payment");
  assert.equal(res.body.data.batch.status, "DISCREPANCY");
  const order = await EcommerceOrder.findById(ctx.orderId).lean();
  assert.equal(order.courierCod.remittanceStatus, EcommerceCourierCodRemittanceStatus.DISCREPANCY);
});

test("record money received rolls back when an order is not collected", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await setupCodStore(tenant, user, branch);
  const collected = await seedCodOrderProcessing({ tenant, user, branch, customer, storeReady: true });
  const pending = await seedCodOrderProcessing({ tenant, user, branch, customer, storeReady: true });
  await shipAndDeliverCollected({ user, orderId: collected.orderId, version: collected.version });
  const shipOnly = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${pending.orderId}/ship`)
    .set(adminHeaders(user))
    .send({ expectedVersion: pending.version, carrierName: "X", trackingNumber: "T-PEND" });
  await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${pending.orderId}/confirm-delivery`)
    .set(adminHeaders(user, randomUUID()))
    .send({
      expectedVersion: shipOnly.body.data.version,
      proofReference: "POD-NO-COD",
      recipientName: "Customer",
    });
  const beforeBatches = await EcommerceCodRemittanceBatch.countDocuments({ tenantId: tenant._id });
  const res = await request(app)
    .post("/api/v1/admin/ecommerce/courier-cod/record-money-received")
    .set(adminHeaders(user, createId("rollback")))
    .send({
      orderIds: [collected.orderId, pending.orderId],
      bankCreditReference: "NEFT-ROLLBACK",
      bankCreditRupees: rupeesFromPaise(collected.totalPaise + pending.totalPaise),
      totalCourierFeeRupees: "0",
    });
  assert.notEqual(res.status, 200);
  const afterBatches = await EcommerceCodRemittanceBatch.countDocuments({ tenantId: tenant._id });
  assert.equal(afterBatches, beforeBatches);
  const okOrder = await EcommerceOrder.findById(collected.orderId).lean();
  assert.equal(okOrder.courierCod.remittanceStatus, EcommerceCourierCodRemittanceStatus.OWED);
});

test("branch manager cannot record money received for another branch order", async () => {
  const { tenant, branch: branchA, user } = await seedTenantUser({});
  const branchB = await seedBranch({ tenantId: tenant._id, code: "BRB3", name: "Branch B" });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branchB._id });
  const ctx = await seedCodOrderProcessing({ tenant, user, branch: branchB, customer });
  await shipAndDeliverCollected({ user, orderId: ctx.orderId, version: ctx.version });
  const manager = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branchA._id,
    role: TenantRole.BRANCH_MANAGER,
    name: "Mgr",
    mobile: "+918811188883",
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
    deviceId: "dev",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const { signAccessToken } = await import("../src/services/token.service.js");
  const managerToken = signAccessToken({
    id: manager._id,
    type: "TENANT_USER",
    tenantId: tenant._id,
    branchId: branchA._id,
    role: TenantRole.BRANCH_MANAGER,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_MANAGER] ?? [],
    deviceId: "dev",
    securityVersion: 0,
    sessionId: sess._id,
  });
  const res = await request(app)
    .post("/api/v1/admin/ecommerce/courier-cod/record-money-received")
    .set({ authorization: `Bearer ${managerToken}`, "x-idempotency-key": createId("deny") })
    .send({
      orderIds: [ctx.orderId],
      bankCreditReference: "NEFT-BRANCH",
      bankCreditRupees: rupeesFromPaise(ctx.totalPaise),
      totalCourierFeeRupees: "0",
    });
  assert.equal(res.status, 403);
});

test("duplicate confirm-delivery idempotency replays with courier collection", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, version } = await seedCodOrderProcessing({ tenant, user, branch, customer });
  const ship = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/ship`)
    .set(adminHeaders(user))
    .send({ expectedVersion: version, carrierName: "X", trackingNumber: "T-DUP" });
  const key = randomUUID();
  const body = {
    expectedVersion: ship.body.data.version,
    proofReference: "POD-DUP",
    recipientName: "Customer",
    courierCollectionReference: "COURIER-DUP-REF",
  };
  const first = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/confirm-delivery`)
    .set(adminHeaders(user, key))
    .send(body);
  const second = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/confirm-delivery`)
    .set(adminHeaders(user, key))
    .send(body);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.headers["x-idempotent-replay"], "true");
});

test("branch manager cannot ship COD order for another branch customer", async () => {
  const { tenant, branch: branchA, user } = await seedTenantUser({});
  const branchB = await seedBranch({ tenantId: tenant._id, code: "BRB2", name: "Branch B" });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branchB._id });
  const { orderId, version } = await seedCodOrderProcessing({
    tenant,
    user,
    branch: branchB,
    customer,
  });
  const manager = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branchA._id,
    role: TenantRole.BRANCH_MANAGER,
    name: "Mgr",
    mobile: "+918811188882",
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
    deviceId: "dev",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const { signAccessToken } = await import("../src/services/token.service.js");
  const managerToken = signAccessToken({
    id: manager._id,
    type: "TENANT_USER",
    tenantId: tenant._id,
    branchId: branchA._id,
    role: TenantRole.BRANCH_MANAGER,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_MANAGER] ?? [],
    deviceId: "dev",
    securityVersion: 0,
    sessionId: sess._id,
  });
  const res = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/ship`)
    .set({ authorization: `Bearer ${managerToken}`, "x-idempotency-key": createId("ship") })
    .send({ expectedVersion: version, carrierName: "X", trackingNumber: "1" });
  assert.equal(res.status, 403);
});
