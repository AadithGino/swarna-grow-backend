process.env.NODE_ENV = "test";

import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceCodRemittanceLineStatus,
  EcommerceFulfilmentMode,
  EcommerceOrderReturnKind,
  TenantRole,
  UserStatus,
  UserType,
} from "../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { createId } from "../src/lib/ids.js";
import {
  EcommerceCodRemittanceBatch,
  EcommerceCodRemittanceLine,
  EcommerceOrder,
  EcommerceOrderReturnRequest,
  Session,
  User,
} from "../src/models/index.js";
import {
  bearerFor,
  resetTestDb,
  seedBranch,
  seedCustomer,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";
import { seedPhase1EcommerceAdminRoles } from "./helpers/phase1-remediation-fixture.js";

const app = createApp();

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

function adminHeaders(user, key = createId("idem")) {
  return {
    authorization: `Bearer ${bearerFor(user)}`,
    "x-idempotency-key": key,
  };
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

async function insertDeliveryOrder({ tenant, customer }) {
  const orderId = createId("eord");
  await EcommerceOrder.collection.insertOne({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customer._id,
    orderNumber: `DEL-${orderId.slice(-4)}`,
    status: "CONFIRMED",
    fulfilmentMode: EcommerceFulfilmentMode.DELIVERY,
    paymentMethod: "ONLINE",
    version: 2,
    lines: [],
  });
  return orderId;
}

test("branch staff and collection agent are denied ecommerce admin routes", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const { staffA, agentA } = await seedPhase1EcommerceAdminRoles({ tenant, branchA: branch, branchB: branch });
  for (const user of [staffA, agentA]) {
    const res = await request(app)
      .get("/api/v1/admin/ecommerce/orders")
      .set("authorization", `Bearer ${bearerFor(user)}`);
    assert.equal(res.status, 403, `${user.role} orders list`);
  }
});

test("tenant owner reads cross-branch order; other tenant admin gets 404", async () => {
  const a = await seedTenantUser({ tenantCode: "ECOM1" });
  const b = await seedTenantUser({ tenantCode: "ECOM2" });
  const branchB = await seedBranch({ tenantId: a.tenant._id, code: "XB", name: "Cross" });
  const customerB = await seedCustomer({ tenantId: a.tenant._id, branchId: branchB._id, mobile: "+919800000401" });
  const orderId = await insertDeliveryOrder({ tenant: a.tenant, customer: customerB });

  const ownerRead = await request(app)
    .get(`/api/v1/admin/ecommerce/orders/${orderId}`)
    .set(adminHeaders(a.user));
  assert.equal(ownerRead.status, 200);

  const foreign = await request(app)
    .get(`/api/v1/admin/ecommerce/orders/${orderId}`)
    .set(adminHeaders(b.user));
  assert.equal(foreign.status, 404);
});

test("branch manager list/count scoped for delivery orders; forged acting branch rejected", async () => {
  const { tenant, branch: branchA } = await seedTenantUser({});
  const branchB = await seedBranch({ tenantId: tenant._id, code: "LSTB", name: "List B" });
  const customerA = await seedCustomer({ tenantId: tenant._id, branchId: branchA._id, mobile: "+919800000501" });
  const customerB = await seedCustomer({ tenantId: tenant._id, branchId: branchB._id, mobile: "+919800000502" });
  const managerA = await seedBranchManager({ tenant, branch: branchA });
  await insertDeliveryOrder({ tenant, customer: customerA });
  await insertDeliveryOrder({ tenant, customer: customerB });

  const list = await request(app)
    .get("/api/v1/admin/ecommerce/orders")
    .set(adminHeaders(managerA));
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 1);
  assert.match(list.body.data[0].orderNumber, /DEL-/);

  const forged = await request(app)
    .get("/api/v1/admin/ecommerce/orders")
    .set({
      ...adminHeaders(managerA),
      "x-acting-branch-id": String(branchB._id),
    });
  assert.equal(forged.status, 403);
});

test("courier COD summary and remittance batch hide other-branch financial rows", async () => {
  const { tenant, branch: branchA, user: owner } = await seedTenantUser({});
  const branchB = await seedBranch({ tenantId: tenant._id, code: "CODB", name: "COD B" });
  const customerA = await seedCustomer({ tenantId: tenant._id, branchId: branchA._id, mobile: "+919800000601" });
  const customerB = await seedCustomer({ tenantId: tenant._id, branchId: branchB._id, mobile: "+919800000602" });
  const managerA = await seedBranchManager({ tenant, branch: branchA });
  const orderA = createId("eord");
  const orderB = createId("eord");
  await EcommerceOrder.collection.insertMany([
    {
      _id: orderA,
      tenantId: tenant._id,
      customerId: customerA._id,
      orderNumber: "COD-A",
      status: "SHIPPED",
      fulfilmentMode: EcommerceFulfilmentMode.DELIVERY,
      paymentMethod: "COD",
      version: 1,
      totalPaise: 50_000,
      courierCod: { collectionStatus: "PENDING", remittanceStatus: "OWED", expectedAmountPaise: 50_000 },
      lines: [],
    },
    {
      _id: orderB,
      tenantId: tenant._id,
      customerId: customerB._id,
      orderNumber: "COD-B",
      status: "SHIPPED",
      fulfilmentMode: EcommerceFulfilmentMode.DELIVERY,
      paymentMethod: "COD",
      version: 1,
      totalPaise: 90_000,
      courierCod: { collectionStatus: "PENDING", remittanceStatus: "OWED", expectedAmountPaise: 90_000 },
      lines: [],
    },
  ]);

  const summaryManager = await request(app)
    .get("/api/v1/admin/ecommerce/courier-cod/summary")
    .set(adminHeaders(managerA));
  assert.equal(summaryManager.status, 200);
  assert.equal(summaryManager.body.data.collectionPendingCount, 1);

  const summaryOwner = await request(app)
    .get("/api/v1/admin/ecommerce/courier-cod/summary")
    .set(adminHeaders(owner));
  assert.equal(summaryOwner.body.data.collectionPendingCount, 2);

  const batch = await EcommerceCodRemittanceBatch.create({
    _id: createId("ecrb"),
    tenantId: tenant._id,
    statementReference: "MIXED-BR",
    status: "DRAFT",
    providerId: "MANUAL",
    createdByUserId: owner._id,
  });
  await EcommerceCodRemittanceLine.insertMany([
    {
      _id: createId("ecrl"),
      tenantId: tenant._id,
      batchId: batch._id,
      orderId: orderA,
      grossPaise: 50_000,
      feePaise: 0,
      status: EcommerceCodRemittanceLineStatus.ACTIVE,
    },
    {
      _id: createId("ecrl"),
      tenantId: tenant._id,
      batchId: batch._id,
      orderId: orderB,
      grossPaise: 90_000,
      feePaise: 0,
      status: EcommerceCodRemittanceLineStatus.ACTIVE,
    },
  ]);

  const batchManager = await request(app)
    .get(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batch._id}`)
    .set(adminHeaders(managerA));
  assert.equal(batchManager.status, 200);
  assert.equal(batchManager.body.data.lines.length, 1);
  assert.equal(batchManager.body.data.lines[0].orderNumber, "COD-A");
  assert.equal(batchManager.body.data.batch.grossExpectedPaise, 50_000);
  assert.notEqual(batchManager.body.data.batch.grossExpectedPaise, 140_000);
  assert.equal(batchManager.body.data.batch.mixedBatch, true);
  assert.equal(batchManager.body.data.batch.bankCreditPaise, undefined);

  const reconcileDenied = await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batch._id}/reconcile`)
    .set(adminHeaders(managerA, createId("idem")))
    .send({ bankCreditReference: "BR-CREDIT-1", bankCreditPaise: 140_000 });
  assert.equal(reconcileDenied.status, 403);
  const batchAfter = await EcommerceCodRemittanceBatch.findById(batch._id).lean();
  assert.equal(batchAfter.status, "DRAFT");

  const listManager = await request(app)
    .get("/api/v1/admin/ecommerce/courier-cod/remittance-batches")
    .set(adminHeaders(managerA));
  assert.equal(listManager.status, 200);
  assert.equal(listManager.body.data.length, 1);
});

test("reconciled mixed batch keeps branch-scoped disclosure without whole-batch bank credit", async () => {
  const { tenant, branch: branchA, user: owner } = await seedTenantUser({});
  const branchB = await seedBranch({ tenantId: tenant._id, code: "RECB", name: "Rec B" });
  const customerA = await seedCustomer({ tenantId: tenant._id, branchId: branchA._id, mobile: "+919800000801" });
  const customerB = await seedCustomer({ tenantId: tenant._id, branchId: branchB._id, mobile: "+919800000802" });
  const managerA = await seedBranchManager({ tenant, branch: branchA });
  const orderA = createId("eord");
  const orderB = createId("eord");
  await EcommerceOrder.collection.insertMany([
    {
      _id: orderA,
      tenantId: tenant._id,
      customerId: customerA._id,
      orderNumber: "REC-A",
      status: "SHIPPED",
      fulfilmentMode: EcommerceFulfilmentMode.DELIVERY,
      paymentMethod: "COD",
      version: 1,
      totalPaise: 50_000,
      courierCod: { collectionStatus: "PENDING", remittanceStatus: "OWED", expectedAmountPaise: 50_000 },
      lines: [],
    },
    {
      _id: orderB,
      tenantId: tenant._id,
      customerId: customerB._id,
      orderNumber: "REC-B",
      status: "SHIPPED",
      fulfilmentMode: EcommerceFulfilmentMode.DELIVERY,
      paymentMethod: "COD",
      version: 1,
      totalPaise: 90_000,
      courierCod: { collectionStatus: "PENDING", remittanceStatus: "OWED", expectedAmountPaise: 90_000 },
      lines: [],
    },
  ]);
  const batch = await EcommerceCodRemittanceBatch.create({
    _id: createId("ecrb"),
    tenantId: tenant._id,
    statementReference: "MIXED-REC",
    status: "DRAFT",
    providerId: "MANUAL",
    createdByUserId: owner._id,
  });
  await EcommerceCodRemittanceLine.insertMany([
    {
      _id: createId("ecrl"),
      tenantId: tenant._id,
      batchId: batch._id,
      orderId: orderA,
      grossPaise: 50_000,
      feePaise: 0,
      status: EcommerceCodRemittanceLineStatus.ACTIVE,
    },
    {
      _id: createId("ecrl"),
      tenantId: tenant._id,
      batchId: batch._id,
      orderId: orderB,
      grossPaise: 90_000,
      feePaise: 0,
      status: EcommerceCodRemittanceLineStatus.ACTIVE,
    },
  ]);
  const reconcile = await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batch._id}/reconcile`)
    .set(adminHeaders(owner, createId("idem")))
    .send({ bankCreditReference: "BR-CREDIT-REC", bankCreditPaise: 140_000 });
  assert.equal(reconcile.status, 200);

  const detailManager = await request(app)
    .get(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batch._id}`)
    .set(adminHeaders(managerA));
  assert.equal(detailManager.status, 200);
  assert.equal(detailManager.body.data.lines.length, 1);
  assert.equal(detailManager.body.data.batch.mixedBatch, true);
  assert.equal(detailManager.body.data.batch.grossExpectedPaise, 50_000);
  assert.equal(detailManager.body.data.batch.bankCreditPaise, undefined);

  const listManager = await request(app)
    .get("/api/v1/admin/ecommerce/courier-cod/remittance-batches")
    .set(adminHeaders(managerA));
  assert.equal(listManager.status, 200);
  assert.equal(listManager.body.data[0].mixedBatch, true);
  assert.equal(listManager.body.data[0].bankCreditPaise, undefined);
  assert.equal(listManager.body.data[0].grossExpectedPaise, 50_000);
});

test("invoice, events and payment-operator routes enforce branch scope without mutation side effects", async () => {
  const { tenant, branch: branchA } = await seedTenantUser({});
  const branchB = await seedBranch({ tenantId: tenant._id, code: "INVB", name: "Inv B" });
  const customerB = await seedCustomer({ tenantId: tenant._id, branchId: branchB._id, mobile: "+919800000701" });
  const managerA = await seedBranchManager({ tenant, branch: branchA });
  const orderId = createId("eord");
  await EcommerceOrder.collection.insertOne({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customerB._id,
    orderNumber: "INV-X",
    status: "CONFIRMED",
    fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
    pickupBranchId: branchB._id,
    paymentMethod: "ONLINE",
    version: 4,
    lines: [],
  });

  const events = await request(app)
    .get(`/api/v1/admin/ecommerce/orders/${orderId}/events`)
    .set(adminHeaders(managerA));
  assert.equal(events.status, 403);

  const invoice = await request(app)
    .get(`/api/v1/admin/ecommerce/orders/${orderId}/invoice.pdf`)
    .set(adminHeaders(managerA));
  assert.ok([403, 422].includes(invoice.status), `invoice status ${invoice.status}`);

  const attemptId = createId("epay");
  await EcommerceOrder.collection.updateOne(
    { _id: orderId },
    { $set: { successfulPaymentAttemptId: attemptId } },
  );
  const { EcommercePaymentAttempt } = await import("../src/models/index.js");
  await EcommercePaymentAttempt.collection.insertOne({
    _id: attemptId,
    tenantId: tenant._id,
    orderId,
    status: "INITIATED",
    operationalStatus: "STUCK_RECONCILE",
    version: 1,
  });

  const provider = await request(app)
    .get(`/api/v1/admin/ecommerce/orders/${orderId}/payment-attempts/${attemptId}/provider-status`)
    .set(adminHeaders(managerA));
  assert.equal(provider.status, 403);

  const before = await EcommerceOrder.findById(orderId).lean();
  const retry = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/payment-attempts/${attemptId}/reconcile-retry`)
    .set(adminHeaders(managerA, randomUUID()))
    .send({ reason: "cross branch attempt should fail" });
  assert.equal(retry.status, 403);
  const after = await EcommerceOrder.findById(orderId).lean();
  assert.equal(after.version, before.version);
});

test("return decision rejected cross-branch leaves return row unchanged", async () => {
  const { tenant, branch: branchA } = await seedTenantUser({});
  const branchB = await seedBranch({ tenantId: tenant._id, code: "RETB", name: "Ret B" });
  const customerB = await seedCustomer({ tenantId: tenant._id, branchId: branchB._id, mobile: "+919800000801" });
  const managerA = await seedBranchManager({ tenant, branch: branchA });
  const orderId = createId("eord");
  const returnId = createId("eret");
  await EcommerceOrder.collection.insertOne({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customerB._id,
    orderNumber: "RET-1",
    status: "DELIVERED",
    fulfilmentMode: EcommerceFulfilmentMode.DELIVERY,
    paymentMethod: "ONLINE",
    version: 2,
    lines: [],
  });
  await EcommerceOrderReturnRequest.collection.insertOne({
    _id: returnId,
    tenantId: tenant._id,
    orderId,
    customerId: customerB._id,
    kind: EcommerceOrderReturnKind.RETURN,
    status: "PENDING_REVIEW",
    reason: "Damaged",
    version: 1,
  });

  const decide = await request(app)
    .post(`/api/v1/admin/ecommerce/return-requests/${returnId}/decision`)
    .set(adminHeaders(managerA, randomUUID()))
    .send({ decision: "APPROVE", expectedVersion: 1, decisionReason: "should fail" });
  assert.equal(decide.status, 403);
  const row = await EcommerceOrderReturnRequest.findById(returnId).lean();
  assert.equal(row.status, "PENDING_REVIEW");
  assert.equal(row.version, 1);
});
