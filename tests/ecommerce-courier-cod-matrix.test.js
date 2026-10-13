import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceCourierCodCollectionStatus,
  EcommerceCourierCodRemittanceStatus,
  EcommerceFulfilmentMode,
  EcommerceOrderCancellationRequestStatus,
  EcommerceOrderStatus,
  EcommercePaymentMethod,
  PlanTier,
  TenantRole,
} from "../src/constants/enums.js";
import {
  EcommerceOrder,
  EcommerceOrderCancellationRequest,
  Tenant,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import {
  disableEcommercePaymentsTestHarness,
  taxReadyCatalogBody,
  taxReadyFulfilmentBody,
} from "./helpers/ecommerce-checkout-fixtures.js";
import { bearerFor, resetTestDb, seedCustomer, seedFixture, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  disableEcommercePaymentsTestHarness();
});

function adminHeaders(user, perms = ROLE_PERMISSIONS[TenantRole.TENANT_ADMIN], key = createId("idem")) {
  return {
    authorization: `Bearer ${bearerFor(user, perms)}`,
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

async function seedDeliveredCod({ tenant, user, branch }) {
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
  const customer = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: `+9198${String(Date.now()).slice(-8)}`,
  });
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
  const order = await request(app)
    .post("/api/v1/app/shop/orders")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("o") })
    .send({ quoteId: quote.body.data.id });
  const orderId = order.body.data.id;
  const staff = adminHeaders(user);
  const accept = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/cod/accept`)
    .set(staff)
    .send({ expectedVersion: order.body.data.version });
  const shipped = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/fulfilment-transition`)
    .set(staff)
    .send({ expectedVersion: accept.body.data.version, targetStatus: EcommerceOrderStatus.SHIPPED });
  await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/delivery-handover`)
    .set({ ...staff, "x-idempotency-key": createId("dh") })
    .send({
      expectedVersion: shipped.body.data.version,
      recipientName: "Customer",
      proofReference: "POD-1",
    });
  const afterHandover = await EcommerceOrder.findById(orderId).lean();
  await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/fulfilment-transition`)
    .set(staff)
    .send({ expectedVersion: afterHandover.version, targetStatus: EcommerceOrderStatus.DELIVERED });
  const row = await EcommerceOrder.findById(orderId).lean();
  return { tenant, user, branch, staff, orderId, totalPaise: row.totalPaise, version: row.version };
}

test("cross-tenant isolation on courier COD writes and reads", async () => {
  const a = await seedTenantUser({});
  const b = await seedFixture();
  const ctx = await seedDeliveredCod(a);
  const foreign = adminHeaders(b.user);
  const confirm = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${ctx.orderId}/courier-cod/confirm-collection`)
    .set({ ...foreign, "x-idempotency-key": createId("col") })
    .send({ expectedVersion: ctx.version, reference: "FOREIGN-POD-1" });
  assert.ok(confirm.status === 404 || confirm.status === 403);

  await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${ctx.orderId}/courier-cod/confirm-collection`)
    .set({ ...ctx.staff, "x-idempotency-key": createId("col") })
    .send({ expectedVersion: ctx.version, reference: "POD-TENANT-A" });
  const batch = await request(app)
    .post("/api/v1/admin/ecommerce/courier-cod/remittance-batches")
    .set({ ...ctx.staff, "x-idempotency-key": createId("b") })
    .send({ statementReference: "STMT-A" });
  const batchId = batch.body.data._id;
  const getForeign = await request(app)
    .get(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batchId}`)
    .set(foreign);
  assert.equal(getForeign.status, 404);
});

test("read-only staff cannot confirm collection or reconcile", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const ctx = await seedDeliveredCod({ tenant, user, branch });
  const readOnly = adminHeaders(user, ["ecommerce.read"]);
  const blocked = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${ctx.orderId}/courier-cod/confirm-collection`)
    .set({ ...readOnly, "x-idempotency-key": createId("col") })
    .send({ expectedVersion: ctx.version, reference: "POD" });
  assert.equal(blocked.status, 403);
});

test("concurrent reconcile — one succeeds, one conflicts", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const ctx = await seedDeliveredCod({ tenant, user, branch });
  let v = ctx.version;
  await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${ctx.orderId}/courier-cod/confirm-collection`)
    .set({ ...ctx.staff, "x-idempotency-key": createId("col") })
    .send({ expectedVersion: v, reference: "POD-CONC" });
  const batchRes = await request(app)
    .post("/api/v1/admin/ecommerce/courier-cod/remittance-batches")
    .set({ ...ctx.staff, "x-idempotency-key": createId("batch") })
    .send({ statementReference: "STMT-CONC" });
  const batchId = batchRes.body.data._id;
  await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batchId}/orders/${ctx.orderId}/lines`)
    .set({ ...ctx.staff, "x-idempotency-key": createId("line") })
    .send({ grossPaise: ctx.totalPaise, feePaise: 100 });
  const net = ctx.totalPaise - 100;
  const [r1, r2] = await Promise.all([
    request(app)
      .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batchId}/reconcile`)
      .set({ ...ctx.staff, "x-idempotency-key": createId("rec1") })
      .send({ bankCreditReference: "NEFT-A", bankCreditPaise: net }),
    request(app)
      .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batchId}/reconcile`)
      .set({ ...ctx.staff, "x-idempotency-key": createId("rec2") })
      .send({ bankCreditReference: "NEFT-B", bankCreditPaise: net }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409]);
});

test("duplicate remittance line idempotency returns same line", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const ctx = await seedDeliveredCod({ tenant, user, branch });
  await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${ctx.orderId}/courier-cod/confirm-collection`)
    .set({ ...ctx.staff, "x-idempotency-key": createId("col") })
    .send({ expectedVersion: ctx.version, reference: "POD-IDEM" });
  const batchRes = await request(app)
    .post("/api/v1/admin/ecommerce/courier-cod/remittance-batches")
    .set({ ...ctx.staff, "x-idempotency-key": createId("batch") })
    .send({ statementReference: "STMT-IDEM" });
  const batchId = batchRes.body.data._id;
  const lineKey = createId("line");
  const l1 = await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batchId}/orders/${ctx.orderId}/lines`)
    .set({ ...ctx.staff, "x-idempotency-key": lineKey })
    .send({ grossPaise: ctx.totalPaise, feePaise: 250 });
  const l2 = await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batchId}/orders/${ctx.orderId}/lines`)
    .set({ ...ctx.staff, "x-idempotency-key": lineKey })
    .send({ grossPaise: ctx.totalPaise, feePaise: 250 });
  assert.equal(l1.status, 200);
  assert.equal(l2.status, 200);
  assert.equal(l1.body.data.line._id, l2.body.data.line._id);
});

test("delivered with collection but no bank receipt stays OWED", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const ctx = await seedDeliveredCod({ tenant, user, branch });
  await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${ctx.orderId}/courier-cod/confirm-collection`)
    .set({ ...ctx.staff, "x-idempotency-key": createId("col") })
    .send({ expectedVersion: ctx.version, reference: "POD-NO-BANK" });
  const row = await EcommerceOrder.findById(ctx.orderId).lean();
  assert.equal(row.courierCod.collectionStatus, EcommerceCourierCodCollectionStatus.CONFIRMED);
  assert.equal(row.courierCod.remittanceStatus, EcommerceCourierCodRemittanceStatus.OWED);
  assert.equal(row.courierCod.bankCreditedAt, undefined);
});

test("COD cancel before collection completes without manual refund", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const orderId = createId("eord");
  await EcommerceOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customer._id,
    orderNumber: "EC-CAN-PRE",
    status: EcommerceOrderStatus.PROCESSING,
    paymentMethod: EcommercePaymentMethod.COD,
    totalPaise: 25_000,
    lines: [],
    version: 2,
  });
  const reqId = createId("ecan");
  await EcommerceOrderCancellationRequest.create({
    _id: reqId,
    tenantId: tenant._id,
    orderId,
    customerId: customer._id,
    kind: "ADMIN_INITIATED",
    reason: "Cancel before courier collection",
    status: EcommerceOrderCancellationRequestStatus.PENDING_DECISION,
    version: 1,
  });
  await EcommerceOrder.updateOne({ _id: orderId }, { $set: { activeCancellationRequestId: reqId } });
  const decision = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/cancellation/decision`)
    .set(adminHeaders(user))
    .send({
      decision: "APPROVE",
      expectedVersion: 1,
      stockDisposition: "STOCK_EXCEPTION",
    });
  assert.equal(decision.status, 200);
  const reqRow = await EcommerceOrderCancellationRequest.findById(reqId).lean();
  assert.equal(reqRow.status, EcommerceOrderCancellationRequestStatus.COMPLETED);
  assert.equal(reqRow.codManualRefund?.recordedAt, undefined);
  assert.equal(reqRow.codRefundContext, undefined);
  const order = await EcommerceOrder.findById(orderId).lean();
  assert.equal(order.status, EcommerceOrderStatus.CANCELLED);
});

test("COD cancel after collection requires manual refund evidence before completion", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const orderId = createId("eord");
  await EcommerceOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customer._id,
    orderNumber: "EC-CAN-POST",
    status: EcommerceOrderStatus.PROCESSING,
    paymentMethod: EcommercePaymentMethod.COD,
    totalPaise: 35_000,
    courierCod: {
      collectionStatus: EcommerceCourierCodCollectionStatus.CONFIRMED,
      collectionConfirmedAt: new Date(),
      collectionReference: "POD-RTO",
      expectedAmountPaise: 35_000,
      remittanceStatus: EcommerceCourierCodRemittanceStatus.OWED,
    },
    lines: [],
    version: 3,
  });
  const reqId = createId("ecan");
  await EcommerceOrderCancellationRequest.create({
    _id: reqId,
    tenantId: tenant._id,
    orderId,
    customerId: customer._id,
    kind: "ADMIN_INITIATED",
    reason: "RTO after courier collection",
    status: EcommerceOrderCancellationRequestStatus.PENDING_DECISION,
    version: 1,
  });
  await EcommerceOrder.updateOne({ _id: orderId }, { $set: { activeCancellationRequestId: reqId } });
  const approve = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/cancellation/decision`)
    .set(adminHeaders(user))
    .send({
      decision: "APPROVE",
      expectedVersion: 1,
      stockDisposition: "STOCK_EXCEPTION",
    });
  assert.equal(approve.status, 200);
  const mid = await EcommerceOrderCancellationRequest.findById(reqId).lean();
  assert.equal(mid.status, EcommerceOrderCancellationRequestStatus.APPROVED_PROCESSING);
  assert.ok(mid.codRefundContext?.capturedAt);
  assert.equal(mid.codManualRefund?.recordedAt, undefined);

  const refund = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/cancellation/cod-manual-refund`)
    .set({ ...adminHeaders(user), "x-idempotency-key": createId("ref") })
    .send({
      amountPaise: 35_000,
      recipient: "Customer Name",
      method: "UPI",
      reference: "UPI-REF-1",
      proofNote: "Refund sent after RTO",
    });
  assert.equal(refund.status, 200);
  const done = await EcommerceOrderCancellationRequest.findById(reqId).lean();
  assert.ok(done.codManualRefund?.recordedAt);
  assert.equal(done.status, EcommerceOrderCancellationRequestStatus.COMPLETED);
});

test("after bank reconciliation customer cancellation request is blocked", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const ctx = await seedDeliveredCod({ tenant, user, branch });
  await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${ctx.orderId}/courier-cod/confirm-collection`)
    .set({ ...ctx.staff, "x-idempotency-key": createId("col") })
    .send({ expectedVersion: ctx.version, reference: "POD-RECON" });
  const batchRes = await request(app)
    .post("/api/v1/admin/ecommerce/courier-cod/remittance-batches")
    .set({ ...ctx.staff, "x-idempotency-key": createId("batch") })
    .send({ statementReference: "STMT-RECON" });
  const batchId = batchRes.body.data._id;
  await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batchId}/orders/${ctx.orderId}/lines`)
    .set({ ...ctx.staff, "x-idempotency-key": createId("line") })
    .send({ grossPaise: ctx.totalPaise, feePaise: 0 });
  await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batchId}/reconcile`)
    .set({ ...ctx.staff, "x-idempotency-key": createId("rec") })
    .send({ bankCreditReference: "NEFT-DONE", bankCreditPaise: ctx.totalPaise });
  const row = await EcommerceOrder.findById(ctx.orderId).lean();
  assert.equal(row.courierCod.remittanceStatus, EcommerceCourierCodRemittanceStatus.BANK_RECONCILED);

  const customer = { _id: row.customerId };
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
  const blocked = await request(app)
    .post(`/api/v1/app/shop/orders/${ctx.orderId}/cancellation-requests`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("creq") })
    .send({ reason: "Cancel after bank reconciliation" });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.error?.code, "CONTACT_STORE_FOR_RETURN");
});
