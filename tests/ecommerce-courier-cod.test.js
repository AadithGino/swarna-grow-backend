import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceCourierCodCollectionStatus,
  EcommerceCourierCodRemittanceStatus,
  EcommerceFulfilmentMode,
  EcommerceOrderStatus,
  EcommercePaymentMethod,
  PlanTier,
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
import { computeEcommerceCollections } from "../src/lib/ecommerce-workspace-collections.js";

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

async function seedCheckoutReady({ tenant, user, branch }) {
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

async function seedCodOrderDelivered({ tenant, user, branch, setupCheckout = true }) {
  const customer = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: `+9198${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 10)}`,
  });
  if (setupCheckout) await seedCheckoutReady({ tenant, user, branch });
  const product = await seedProduct(tenant, user);
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
  const staffAuth = adminHeaders(user);
  const accept = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/cod/accept`)
    .set(staffAuth)
    .send({ expectedVersion: order.body.data.version });
  const shipped = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/fulfilment-transition`)
    .set(staffAuth)
    .send({ expectedVersion: accept.body.data.version, targetStatus: EcommerceOrderStatus.SHIPPED });
  await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/delivery-handover`)
    .set({ ...staffAuth, "x-idempotency-key": createId("dh") })
    .send({
      expectedVersion: shipped.body.data.version,
      recipientName: "Customer",
      proofReference: "POD-PHOTO-1",
    });
  const afterHandover = await EcommerceOrder.findById(orderId).lean();
  await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/fulfilment-transition`)
    .set(staffAuth)
    .send({ expectedVersion: afterHandover.version, targetStatus: EcommerceOrderStatus.DELIVERED });
  const row = await EcommerceOrder.findById(orderId).lean();
  return { tenant, staffAuth, orderId, totalPaise: row.totalPaise };
}

test("delivered without courier collection confirmation is allowed", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { orderId } = await seedCodOrderDelivered({ tenant, user, branch });
  const row = await EcommerceOrder.findById(orderId).lean();
  assert.equal(row.status, EcommerceOrderStatus.DELIVERED);
  assert.equal(row.courierCod.collectionStatus, EcommerceCourierCodCollectionStatus.PENDING);
});

test("remittance batch covers multiple orders with fees and bank match", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const a = await seedCodOrderDelivered({ tenant, user, branch });
  const b = await seedCodOrderDelivered({ tenant, user, branch, setupCheckout: false });
  for (const ctx of [a, b]) {
    const v = (await EcommerceOrder.findById(ctx.orderId)).version;
    await request(app)
      .post(`/api/v1/admin/ecommerce/orders/${ctx.orderId}/courier-cod/confirm-collection`)
      .set({ ...ctx.staffAuth, "x-idempotency-key": createId("col") })
      .send({ expectedVersion: v, reference: "COURIER-POD-1" });
  }
  const batchRes = await request(app)
    .post("/api/v1/admin/ecommerce/courier-cod/remittance-batches")
    .set({ ...a.staffAuth, "x-idempotency-key": createId("batch") })
    .send({ statementReference: "STMT-APR-1" });
  assert.equal(batchRes.status, 200);
  const batchId = batchRes.body.data._id;
  const feeA = 100;
  const feeB = 50;
  await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batchId}/orders/${a.orderId}/lines`)
    .set({ ...a.staffAuth, "x-idempotency-key": createId("l1") })
    .send({ grossPaise: a.totalPaise, feePaise: feeA });
  await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batchId}/orders/${b.orderId}/lines`)
    .set({ ...a.staffAuth, "x-idempotency-key": createId("l2") })
    .send({ grossPaise: b.totalPaise, feePaise: feeB });
  const net = a.totalPaise + b.totalPaise - feeA - feeB;
  const recon = await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batchId}/reconcile`)
    .set({ ...a.staffAuth, "x-idempotency-key": createId("rec") })
    .send({ bankCreditReference: "NEFT-1", bankCreditPaise: net });
  assert.equal(recon.status, 200);
  assert.equal(recon.body.data.status, "BANK_RECONCILED");
  const rowA = await EcommerceOrder.findById(a.orderId).lean();
  assert.equal(rowA.courierCod.remittanceStatus, EcommerceCourierCodRemittanceStatus.BANK_RECONCILED);
});

test("duplicate order in batch and duplicate reconcile are idempotent", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const ctx = await seedCodOrderDelivered({ tenant, user, branch });
  const v = (await EcommerceOrder.findById(ctx.orderId)).version;
  await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${ctx.orderId}/courier-cod/confirm-collection`)
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("col") })
    .send({ expectedVersion: v, reference: "COURIER-POD-1" });
  const batch1 = await request(app)
    .post("/api/v1/admin/ecommerce/courier-cod/remittance-batches")
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("b1") })
    .send({ statementReference: "STMT-1" });
  await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batch1.body.data._id}/orders/${ctx.orderId}/lines`)
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("l1") })
    .send({ grossPaise: ctx.totalPaise, feePaise: 0 });
  const batch2 = await request(app)
    .post("/api/v1/admin/ecommerce/courier-cod/remittance-batches")
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("b2") })
    .send({ statementReference: "STMT-2" });
  const dup = await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batch2.body.data._id}/orders/${ctx.orderId}/lines`)
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("l2") })
    .send({ grossPaise: ctx.totalPaise, feePaise: 0 });
  assert.equal(dup.status, 409);
  const idemKey = createId("rec");
  const r1 = await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batch1.body.data._id}/reconcile`)
    .set({ ...ctx.staffAuth, "x-idempotency-key": idemKey })
    .send({ bankCreditReference: "NEFT-1", bankCreditPaise: ctx.totalPaise });
  const r2 = await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batch1.body.data._id}/reconcile`)
    .set({ ...ctx.staffAuth, "x-idempotency-key": idemKey })
    .send({ bankCreditReference: "NEFT-1", bankCreditPaise: ctx.totalPaise });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
});

test("report totals: courier confirmed does not count as bank gross", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const ctx = await seedCodOrderDelivered({ tenant, user, branch });
  const confirmedAt = new Date("2026-04-10T10:00:00.000Z");
  await EcommerceOrder.updateOne(
    { _id: ctx.orderId },
    {
      $set: {
        "courierCod.collectionStatus": EcommerceCourierCodCollectionStatus.CONFIRMED,
        "courierCod.collectionConfirmedAt": confirmedAt,
        "courierCod.expectedAmountPaise": ctx.totalPaise,
        "courierCod.remittanceStatus": EcommerceCourierCodRemittanceStatus.OWED,
      },
    },
  );
  const mid = await computeEcommerceCollections(tenant._id, "2026-04-01", "2026-04-30");
  assert.equal(mid.codCourierCollectionConfirmedPaise, ctx.totalPaise);
  assert.equal(mid.codBankRemittanceReconciledPaise, 0);
  assert.equal(mid.grossCollectedPaise, 0);
});

test("short bank remittance marks batch discrepancy", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const ctx = await seedCodOrderDelivered({ tenant, user, branch });
  const v = (await EcommerceOrder.findById(ctx.orderId)).version;
  await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${ctx.orderId}/courier-cod/confirm-collection`)
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("col") })
    .send({ expectedVersion: v, reference: "COURIER-POD-SHORT" });
  const batchRes = await request(app)
    .post("/api/v1/admin/ecommerce/courier-cod/remittance-batches")
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("batch") })
    .send({ statementReference: "STMT-SHORT" });
  const batchId = batchRes.body.data._id;
  await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batchId}/orders/${ctx.orderId}/lines`)
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("l1") })
    .send({ grossPaise: ctx.totalPaise, feePaise: 200 });
  const net = ctx.totalPaise - 200;
  const recon = await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batchId}/reconcile`)
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("rec") })
    .send({ bankCreditReference: "NEFT-SHORT", bankCreditPaise: net - 500 });
  assert.equal(recon.status, 200);
  assert.equal(recon.body.data.status, "DISCREPANCY");
  const row = await EcommerceOrder.findById(ctx.orderId).lean();
  assert.equal(row.courierCod.remittanceStatus, EcommerceCourierCodRemittanceStatus.DISCREPANCY);
});

test("remittance line gross must match order total", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const ctx = await seedCodOrderDelivered({ tenant, user, branch });
  const v = (await EcommerceOrder.findById(ctx.orderId)).version;
  await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${ctx.orderId}/courier-cod/confirm-collection`)
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("col") })
    .send({ expectedVersion: v, reference: "COURIER-POD-WRONG" });
  const batchRes = await request(app)
    .post("/api/v1/admin/ecommerce/courier-cod/remittance-batches")
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("batch") })
    .send({ statementReference: "STMT-WRONG" });
  const bad = await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batchRes.body.data._id}/orders/${ctx.orderId}/lines`)
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("l1") })
    .send({ grossPaise: ctx.totalPaise - 1, feePaise: 0 });
  assert.equal(bad.status, 422);
});

test("duplicate reconcile without idempotency key conflicts", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const ctx = await seedCodOrderDelivered({ tenant, user, branch });
  const v = (await EcommerceOrder.findById(ctx.orderId)).version;
  await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${ctx.orderId}/courier-cod/confirm-collection`)
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("col") })
    .send({ expectedVersion: v, reference: "COURIER-POD-DUP" });
  const batchRes = await request(app)
    .post("/api/v1/admin/ecommerce/courier-cod/remittance-batches")
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("batch") })
    .send({ statementReference: "STMT-DUP" });
  const batchId = batchRes.body.data._id;
  await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batchId}/orders/${ctx.orderId}/lines`)
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("l1") })
    .send({ grossPaise: ctx.totalPaise, feePaise: 0 });
  await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batchId}/reconcile`)
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("rec1") })
    .send({ bankCreditReference: "NEFT-1", bankCreditPaise: ctx.totalPaise });
  const again = await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batchId}/reconcile`)
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("rec2") })
    .send({ bankCreditReference: "NEFT-2", bankCreditPaise: ctx.totalPaise });
  assert.equal(again.status, 409);
});

test("remittance line rejects fee greater than gross", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const ctx = await seedCodOrderDelivered({ tenant, user, branch });
  const v = (await EcommerceOrder.findById(ctx.orderId)).version;
  await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${ctx.orderId}/courier-cod/confirm-collection`)
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("col") })
    .send({ expectedVersion: v, reference: "COURIER-POD-FEE" });
  const batchRes = await request(app)
    .post("/api/v1/admin/ecommerce/courier-cod/remittance-batches")
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("batch") })
    .send({ statementReference: "STMT-FEE" });
  const bad = await request(app)
    .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batchRes.body.data._id}/orders/${ctx.orderId}/lines`)
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("l1") })
    .send({ grossPaise: ctx.totalPaise, feePaise: ctx.totalPaise + 1 });
  assert.equal(bad.status, 422);
});

test("confirm collection idempotency key with different body returns 409", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const ctx = await seedCodOrderDelivered({ tenant, user, branch });
  const v = (await EcommerceOrder.findById(ctx.orderId)).version;
  const key = createId("idem-col");
  const ok = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${ctx.orderId}/courier-cod/confirm-collection`)
    .set({ ...ctx.staffAuth, "x-idempotency-key": key })
    .send({ expectedVersion: v, reference: "COURIER-POD-A" });
  assert.equal(ok.status, 200);
  const conflict = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${ctx.orderId}/courier-cod/confirm-collection`)
    .set({ ...ctx.staffAuth, "x-idempotency-key": key })
    .send({ expectedVersion: v, reference: "COURIER-POD-B" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error?.code, "IDEMPOTENCY_KEY_REUSED");
});

test("same bank credit reference cannot reconcile two batches", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const a = await seedCodOrderDelivered({ tenant, user, branch });
  const b = await seedCodOrderDelivered({ tenant, user, branch, setupCheckout: false });
  for (const ctx of [a, b]) {
    const v = (await EcommerceOrder.findById(ctx.orderId)).version;
    await request(app)
      .post(`/api/v1/admin/ecommerce/orders/${ctx.orderId}/courier-cod/confirm-collection`)
      .set({ ...ctx.staffAuth, "x-idempotency-key": createId("col") })
      .send({ expectedVersion: v, reference: "COURIER-POD-BC" });
  }
  async function reconcileOne(orderCtx, stmt, bankRef) {
    const batchRes = await request(app)
      .post("/api/v1/admin/ecommerce/courier-cod/remittance-batches")
      .set({ ...orderCtx.staffAuth, "x-idempotency-key": createId("batch") })
      .send({ statementReference: stmt });
    const batchId = batchRes.body.data._id;
    await request(app)
      .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batchId}/orders/${orderCtx.orderId}/lines`)
      .set({ ...orderCtx.staffAuth, "x-idempotency-key": createId("line") })
      .send({ grossPaise: orderCtx.totalPaise, feePaise: 0 });
    return request(app)
      .post(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${batchId}/reconcile`)
      .set({ ...orderCtx.staffAuth, "x-idempotency-key": createId("rec") })
      .send({ bankCreditReference: bankRef, bankCreditPaise: orderCtx.totalPaise });
  }
  const first = await reconcileOne(a, "STMT-BC-1", "NEFT-SHARED-REF");
  assert.equal(first.status, 200);
  const second = await reconcileOne(b, "STMT-BC-2", "NEFT-SHARED-REF");
  assert.equal(second.status, 409);
  assert.equal(second.body.error?.code, "BANK_CREDIT_ALREADY_RECONCILED");
});

test("staff record-collection endpoint removed", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const ctx = await seedCodOrderDelivered({ tenant, user, branch });
  const res = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${ctx.orderId}/cod/record-collection`)
    .set({ ...ctx.staffAuth, "x-idempotency-key": createId("x") })
    .send({ expectedVersion: 1, amountPaise: ctx.totalPaise, reference: "x" });
  assert.equal(res.status, 404);
});
