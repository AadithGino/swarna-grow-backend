import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
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
    sku: "GOLD-2G",
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
  const order = await request(app)
    .post("/api/v1/app/digital-metals/redemption/orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: quote.body.data.quoteId,
      termsVersionAccepted: quote.body.data.termsVersion,
      termsContentHashAccepted: quote.body.data.termsContentHash,
    });
  assert.equal(order.body.data.status, "CHARGE_PAID");
  return { orderId: order.body.data.id, adminToken: bearerFor(user), branch, token };
}

test("pickup handover consumes metal exactly once and records physical-out event", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, adminToken, token } = await seedPaidPickupOrder({ tenant, branch, user, customer });
  const walletBefore = await DigitalMetalWallet.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    metal: "GOLD",
    finenessPpm: 999_000,
  }).lean();
  assert.equal(Number(walletBefore.reservedUg), G2);

  let v = 1;
  await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/accept`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: v++, fulfilmentBranchId: branch._id });
  await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/packing`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: v++ });
  await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/pickup-ready`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: v++ });
  const codeRes = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/pickup-code`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: v++ });
  assert.equal(codeRes.body.data.pickupCodeIssued, true);
  const reveal = await request(app)
    .get(`/api/v1/app/digital-metals/redemption/orders/${orderId}/pickup-instructions`)
    .set("Authorization", `Bearer ${token}`);
  const pickupCode = reveal.body.data.pickupCode;
  const complete = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/complete-pickup`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: v++, pickupCode, fulfilmentBranchId: branch._id });
  assert.equal(complete.status, 200);
  assert.equal(complete.body.data.status, "COMPLETED");
  const events = await DigitalMetalPhysicalOutEvent.find({ redemptionOrderId: orderId }).lean();
  assert.equal(events.length, 1);
  assert.equal(Number(events[0].quantityUg), G2);
  const walletAfter = await DigitalMetalWallet.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    metal: "GOLD",
    finenessPpm: 999_000,
  }).lean();
  assert.equal(Number(walletAfter.reservedUg), 0);
  assert.equal(Number(walletAfter.heldUg), Number(walletBefore.heldUg) - G2);
  const dup = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/complete-pickup`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: v, pickupCode, fulfilmentBranchId: branch._id });
  assert.equal(dup.status, 409);
  const progress = await request(app)
    .get(`/api/v1/app/digital-metals/redemption/orders/${orderId}/fulfilment`)
    .set("Authorization", `Bearer ${token}`);
  assert.equal(progress.status, 200);
  assert.equal(progress.body.data.status, "COMPLETED");
});

test("dispatch preserves reservation until delivery completion", async () => {
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
    sku: "DEL-2G",
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
  let v = 1;
  for (const step of ["accept", "packing", "dispatch"]) {
    const path =
      step === "accept"
        ? "accept"
        : step === "packing"
          ? "packing"
          : "dispatch";
    const body =
      step === "dispatch"
        ? { expectedVersion: v++, carrier: "Manual", trackingReference: "TRK1" }
        : { expectedVersion: v++ };
    const res = await request(app)
      .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/${path}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Idempotency-Key", randomUUID())
      .send(body);
    assert.equal(res.status, 200, step);
  }
  const wallet = await DigitalMetalWallet.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    metal: "GOLD",
    finenessPpm: 999_000,
  }).lean();
  assert.equal(Number(wallet.reservedUg), G2);
  const row = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  assert.equal(row.status, "DISPATCHED");
});

test("late charge success creates refund case with operational path", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, adminToken } = await seedPaidPickupOrder({ tenant, branch, user, customer });
  await DigitalMetalRedemptionOrder.updateOne(
    { _id: orderId },
    { $set: { status: "EXPIRED", chargePaymentExpiresAt: new Date(Date.now() - 60_000) } },
  );
  const { finalizeDigitalMetalRedemptionChargeSuccess } = await import(
    "../src/services/digital-metals-redemption-charge-finalize.service.js"
  );
  const { DigitalMetalRedemptionPaymentAttempt, DigitalMetalRedemptionChargeRefundCase } =
    await import("../src/models/index.js");
  const attempt = await DigitalMetalRedemptionPaymentAttempt.create({
    _id: createId("dmrpay"),
    tenantId: tenant._id,
    orderId,
    customerId: customer._id,
    amountPaise: 100,
    merchantOrderId: createId("dmrpay"),
    idempotencyKey: randomUUID(),
    status: "INITIATED",
  });
  await finalizeDigitalMetalRedemptionChargeSuccess({
    tenantId: tenant._id,
    merchantOrderId: attempt._id,
    transactionId: "tx-late",
    amountPaise: 100,
    source: "TEST",
  });
  const refund = await DigitalMetalRedemptionChargeRefundCase.findOne({ redemptionOrderId: orderId }).lean();
  assert.ok(refund);
  const manual = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/charge-refunds/${refund._id}/record-manual`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ resolutionNote: "Refunded via NEFT", evidenceUploadIds: ["upl_1"] });
  assert.equal(manual.status, 200);
});
