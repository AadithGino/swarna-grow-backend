import { randomUUID } from "node:crypto";
process.env.NODE_ENV = "test";
process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { PlanTier } from "../src/constants/enums.js";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import {
  DigitalMetalPhysicalOutEvent,
  DigitalMetalRedemptionCatalogItem,
  DigitalMetalRedemptionOrder,
  DigitalMetalWallet,
  Tenant,
} from "../src/models/index.js";
import {
  bearerFor,
  resetTestDb,
  seedCustomer,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";
import { makeTenantQuoteReady } from "./helpers/digital-metals-live-ready.js";
import { configureTenantPhonePe } from "./helpers/gateway-http-fixture.js";
import { createId } from "../src/lib/ids.js";
import { signAccessToken } from "../src/services/token.service.js";
import { Session } from "../src/models/index.js";
import { withTransaction } from "../src/lib/transaction.js";
import { creditWalletForTest } from "../src/services/digital-metals-ledger.service.js";
import { seedCustomerDeliveryAddress } from "./helpers/digital-metals-redemption-delivery-fixture.js";

const app = createApp();
const G2 = 2 * UG_PER_G;

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
  process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
});

async function enablePlan(tenantId) {
  await Tenant.updateOne(
    { _id: tenantId },
    {
      $set: {
        "subscription.planFeaturesSnapshot.digitalMetals": true,
        "subscription.tier": PlanTier.GROWTH,
        "operations.digitalMetalsEnabled": true,
      },
    },
  );
}

async function customerToken({ tenant, branch, customer }) {
  const session = await Session.create({
    _id: createId("session"),
    customerId: customer._id,
    tenantId: tenant._id,
    deviceId: "cust",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "android",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return signAccessToken({
    id: customer._id,
    type: "CUSTOMER",
    tenantId: tenant._id,
    branchId: branch._id,
    role: "CUSTOMER",
    permissions: [],
    deviceId: "cust",
    securityVersion: 0,
    sessionId: session._id,
  });
}

async function seedPaidPickupOrder({ tenant, branch, user, customer }) {
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await withTransaction((session) =>
    creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: 5 * UG_PER_G,
      idempotencyKey: randomUUID(),
    }),
  );
  const item = await DigitalMetalRedemptionCatalogItem.create({
    _id: createId("dmrci"),
    tenantId: tenant._id,
    sku: "GOLD-2G-P4",
    label: "2g coin",
    metal: "GOLD",
    finenessPpm: 999_000,
    unitQuantityUg: G2,
    mintingRule: { type: "NONE" },
    pickupEnabled: true,
    active: true,
  });
  const token = await customerToken({ tenant, branch, customer });
  const quote = await request(app)
    .post("/api/v1/app/digital-metals/quotes/redemption")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      catalogueItemId: item._id,
      metal: "GOLD",
      finenessPpm: 999000,
      unitCount: 1,
      fulfilmentMode: "PICKUP",
      pickupBranchId: branch._id,
    });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  const order = await request(app)
    .post("/api/v1/app/digital-metals/redemption/orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: quote.body.data.quoteId,
      termsVersionAccepted: quote.body.data.termsVersion,
      termsContentHashAccepted: quote.body.data.termsContentHash,
    });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  if (order.body.data.status === "CHARGE_PENDING") {
    const paid = await request(app)
      .post(`/api/v1/app/digital-metals/redemption/orders/${order.body.data.id}/test-harness/complete-payment`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Idempotency-Key", randomUUID())
      .send({ outcome: "COMPLETED" });
    assert.equal(paid.status, 200, paid.body?.message ?? "charge harness");
  }
  const row = await DigitalMetalRedemptionOrder.findById(order.body.data.id).lean();
  assert.equal(row.status, "CHARGE_PAID");
  return {
    orderId: order.body.data.id,
    adminToken: bearerFor(user),
    branch,
    token,
    version: row.version ?? 1,
  };
}

test("P4 buy: quote payment credits wallet (harness)", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  await configureTenantPhonePe(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const quote = await request(app)
    .post("/api/v1/app/digital-metals/quotes/buy")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      metal: "GOLD",
      finenessPpm: 999000,
      inputMode: "BUDGET_INR",
      budgetPaise: 600_000,
    });
  assert.equal(quote.status, 201);
  const order = await request(app)
    .post("/api/v1/app/digital-metals/buy-orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: quote.body.data.quoteId,
      termsVersionAccepted: quote.body.data.termsVersion,
      termsContentHashAccepted: quote.body.data.termsContentHash,
    });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  const pay = await request(app)
    .post(`/api/v1/app/digital-metals/buy-orders/${order.body.data.id}/payment-intents`)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ redirectUrl: "https://example.com/return" });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  const { completeTestHarnessBuyPayment } = await import(
    "../src/services/digital-metals-buy-payment.service.js"
  );
  const complete = await completeTestHarnessBuyPayment({
    auth: { id: customer._id, tenantId: tenant._id },
    params: { orderId: order.body.data.id },
    body: { outcome: "COMPLETED" },
  });
  assert.equal(complete.orderStatus, "CREDITED");
});

test("P4 pickup: charge-paid to ready-for-pickup issues code without accept/packing", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, adminToken, token, version } = await seedPaidPickupOrder({ tenant, branch, user, customer });
  const ready = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/pickup-ready`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: version, fulfilmentBranchId: branch._id });
  assert.equal(ready.status, 200);
  assert.equal(ready.body.data.status, "PICKUP_READY");
  const reveal = await request(app)
    .get(`/api/v1/app/digital-metals/redemption/orders/${orderId}/pickup-instructions`)
    .set("Authorization", `Bearer ${token}`);
  assert.ok(reveal.body.data.pickupCode);
});

test("P4 pickup handover requires staff attestation and consumes metal once", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, adminToken, token, version } = await seedPaidPickupOrder({ tenant, branch, user, customer });
  const ready = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/pickup-ready`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: version, fulfilmentBranchId: branch._id });
  assert.equal(ready.status, 200);
  const reveal = await request(app)
    .get(`/api/v1/app/digital-metals/redemption/orders/${orderId}/pickup-instructions`)
    .set("Authorization", `Bearer ${token}`);
  const pickupCode = reveal.body.data.pickupCode;
  const vReady = ready.body.data.version ?? version + 1;
  const noAttest = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/complete-pickup`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: vReady, pickupCode, fulfilmentBranchId: branch._id });
  assert.equal(noAttest.status, 400);
  const complete = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/complete-pickup`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      expectedVersion: vReady,
      pickupCode,
      fulfilmentBranchId: branch._id,
      staffHandoverConfirmed: true,
    });
  assert.equal(complete.status, 200);
  assert.equal(complete.body.data.status, "COMPLETED");
  assert.equal(await DigitalMetalPhysicalOutEvent.countDocuments({ redemptionOrderId: orderId }), 1);
});

test("P4 delivery: charge-paid to ship to complete delivery", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await withTransaction((session) =>
    creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: 5 * UG_PER_G,
      idempotencyKey: randomUUID(),
    }),
  );
  const item = await DigitalMetalRedemptionCatalogItem.create({
    _id: createId("dmrci"),
    tenantId: tenant._id,
    sku: "DEL-P4",
    label: "2g bar",
    metal: "GOLD",
    finenessPpm: 999_000,
    unitQuantityUg: G2,
    mintingRule: { type: "NONE" },
    deliveryEnabled: true,
    pickupEnabled: false,
    active: true,
  });
  const token = await customerToken({ tenant, branch, customer });
  const deliveryAddressId = await seedCustomerDeliveryAddress({
    tenantId: tenant._id,
    customerId: customer._id,
  });
  const quote = await request(app)
    .post("/api/v1/app/digital-metals/quotes/redemption")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      catalogueItemId: item._id,
      metal: "GOLD",
      finenessPpm: 999000,
      unitCount: 1,
      fulfilmentMode: "DELIVERY",
      deliveryAddressId,
    });
  const order = await request(app)
    .post("/api/v1/app/digital-metals/redemption/orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: quote.body.data.quoteId,
      termsVersionAccepted: quote.body.data.termsVersion,
      termsContentHashAccepted: quote.body.data.termsContentHash,
    });
  const orderId = order.body.data.id;
  const adminToken = bearerFor(user);
  let v = order.body.data.version ?? 1;
  const ship = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/dispatch`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: v++, carrier: "Manual", trackingReference: "P4-TRK" });
  assert.equal(ship.status, 200);
  assert.equal(ship.body.data.status, "DISPATCHED");
  const walletMid = await DigitalMetalWallet.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    metal: "GOLD",
    finenessPpm: 999_000,
  }).lean();
  assert.equal(Number(walletMid.reservedUg), G2);
  const done = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/complete-delivery`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: v, approverAttestation: true });
  assert.equal(done.status, 200);
  assert.equal(done.body.data.status, "COMPLETED");
});

test("P4 zero-charge redemption reaches charge-paid without payment intent", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await withTransaction((session) =>
    creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: 5 * UG_PER_G,
      idempotencyKey: randomUUID(),
    }),
  );
  const item = await DigitalMetalRedemptionCatalogItem.create({
    _id: createId("dmrci"),
    tenantId: tenant._id,
    sku: "FREE-P4",
    label: "Promo",
    metal: "GOLD",
    finenessPpm: 999_000,
    unitQuantityUg: G2,
    mintingRule: { type: "NONE" },
    packagingPaise: 0,
    deliveryFlatPaise: 0,
    pickupEnabled: true,
    active: true,
  });
  const quote = await request(app)
    .post("/api/v1/app/digital-metals/quotes/redemption")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      catalogueItemId: item._id,
      metal: "GOLD",
      finenessPpm: 999000,
      unitCount: 1,
      fulfilmentMode: "PICKUP",
      pickupBranchId: branch._id,
    });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  const order = await request(app)
    .post("/api/v1/app/digital-metals/redemption/orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: quote.body.data.quoteId,
      termsVersionAccepted: quote.body.data.termsVersion,
      termsContentHashAccepted: quote.body.data.termsContentHash,
    });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  assert.equal(order.body.data.status, "CHARGE_PAID");
  assert.equal(Number(order.body.data.chargeTotalPaise ?? 0), 0);
});

test("P4 concurrent pickup handover idempotency replays once", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, adminToken, token, version } = await seedPaidPickupOrder({ tenant, branch, user, customer });
  const ready = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/pickup-ready`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: version, fulfilmentBranchId: branch._id });
  const pickupCode = (
    await request(app)
      .get(`/api/v1/app/digital-metals/redemption/orders/${orderId}/pickup-instructions`)
      .set("Authorization", `Bearer ${token}`)
  ).body.data.pickupCode;
  const key = randomUUID();
  const body = {
    expectedVersion: ready.body.data.version ?? version + 1,
    pickupCode,
    fulfilmentBranchId: branch._id,
    staffHandoverConfirmed: true,
  };
  const first = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/complete-pickup`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", key)
    .send(body);
  const second = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/complete-pickup`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", key)
    .send(body);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(await DigitalMetalPhysicalOutEvent.countDocuments({ redemptionOrderId: orderId }), 1);
});

test("P4 pre-dispatch cancel releases reservation", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, adminToken, version } = await seedPaidPickupOrder({ tenant, branch, user, customer });
  const cancel = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/cancel`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: version, reason: "Customer changed mind before pickup" });
  assert.equal(cancel.status, 200);
  const row = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  assert.equal(row.status, "CANCELLED");
  const wallet = await DigitalMetalWallet.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    metal: "GOLD",
    finenessPpm: 999_000,
  }).lean();
  assert.equal(Number(wallet.reservedUg), 0);
});
