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
  DigitalMetalRedemptionChargeRefundCase,
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
  return { orderId: order.body.data.id, adminToken: bearerFor(user), branch, token, version: 1 };
}

async function advanceToPickupReady({ orderId, adminToken, branch, token }) {
  let v = 1;
  for (const [path, body] of [
    ["accept", { expectedVersion: v++, fulfilmentBranchId: branch._id }],
    ["packing", { expectedVersion: v++ }],
    ["pickup-ready", { expectedVersion: v++ }],
  ]) {
    const res = await request(app)
      .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/${path}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Idempotency-Key", randomUUID())
      .send(body);
    assert.equal(res.status, 200, path);
  }
  await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/pickup-code`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: v++ });
  const reveal = await request(app)
    .get(`/api/v1/app/digital-metals/redemption/orders/${orderId}/pickup-instructions`)
    .set("Authorization", `Bearer ${token}`);
  return { pickupCode: reveal.body.data.pickupCode, version: v, branch };
}

test("pickup: wrong branch, expiry, attempt limit and customer reveal", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, adminToken, token } = await seedPaidPickupOrder({ tenant, branch, user, customer });
  const { pickupCode, version } = await advanceToPickupReady({ orderId, adminToken, branch, token });

  const reveal = await request(app)
    .get(`/api/v1/app/digital-metals/redemption/orders/${orderId}/pickup-instructions`)
    .set("Authorization", `Bearer ${token}`);
  assert.equal(reveal.status, 200);
  assert.equal(reveal.body.data.pickupCode, pickupCode);

  const wrongBranch = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/complete-pickup`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      expectedVersion: version,
      pickupCode,
      fulfilmentBranchId: createId("branch"),
    });
  assert.equal(wrongBranch.status, 403);

  for (let i = 0; i < 5; i += 1) {
    await request(app)
      .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/complete-pickup`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Idempotency-Key", randomUUID())
      .send({ expectedVersion: version, pickupCode: "000000", fulfilmentBranchId: branch._id });
  }
  const locked = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/complete-pickup`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: version, pickupCode, fulfilmentBranchId: branch._id });
  assert.equal(locked.status, 403);

  await DigitalMetalRedemptionOrder.updateOne(
    { _id: orderId },
    { $set: { pickupCodeAttempts: 0, pickupCodeExpiresAt: new Date(Date.now() - 60_000) } },
  );
  const expired = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/complete-pickup`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: version, pickupCode, fulfilmentBranchId: branch._id });
  assert.equal(expired.status, 409);
});

test("concurrent pre-dispatch cancel vs packing — only one succeeds", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, adminToken } = await seedPaidPickupOrder({ tenant, branch, user, customer });
  await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/accept`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: 1, fulfilmentBranchId: branch._id });
  const v = 2;
  const [cancelRes, packRes] = await Promise.all([
    request(app)
      .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Idempotency-Key", randomUUID())
      .send({ expectedVersion: v, reason: "race" }),
    request(app)
      .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/packing`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Idempotency-Key", randomUUID())
      .send({ expectedVersion: v }),
  ]);
  const ok = [cancelRes.status, packRes.status].filter((s) => s === 200);
  assert.equal(ok.length, 1);
  const row = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  assert.ok(["CANCELLED", "PACKING"].includes(row.status));
});

test("RTO investigation: verified return releases reservation; replacement dispatch keeps reservation", async () => {
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
    sku: "DEL",
    label: "del",
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
  const orderRes = await request(app)
    .post("/api/v1/app/digital-metals/redemption/orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: quote.body.data.quoteId,
      termsVersionAccepted: quote.body.data.termsVersion,
      termsContentHashAccepted: quote.body.data.termsContentHash,
    });
  const orderId = orderRes.body.data.id;
  const adminToken = bearerFor(user);
  for (const step of ["accept", "packing", "dispatch"]) {
    const row = await DigitalMetalRedemptionOrder.findById(orderId).lean();
    const body =
      step === "accept"
        ? { expectedVersion: row.version, fulfilmentBranchId: branch._id }
        : step === "dispatch"
          ? { expectedVersion: row.version, carrier: "Manual", trackingReference: "RTO-1" }
          : { expectedVersion: row.version };
    const res = await request(app)
      .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/${step}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Idempotency-Key", randomUUID())
      .send(body);
    assert.equal(res.status, 200, step);
  }
  const beforeInv = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  const inv = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/investigation`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: beforeInv.version, reason: "RTO" });
  assert.equal(inv.status, 200);
  const walletMid = await DigitalMetalWallet.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    metal: "GOLD",
    finenessPpm: 999_000,
  }).lean();
  assert.equal(Number(walletMid.reservedUg), G2);

  const resolved = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/resolve-return`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: inv.body.data.version, reason: "Verified return" });
  assert.equal(resolved.status, 200);
  const walletReleased = await DigitalMetalWallet.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    metal: "GOLD",
    finenessPpm: 999_000,
  }).lean();
  assert.equal(Number(walletReleased.reservedUg), 0);
});

test("replacement dispatch after investigation keeps reservation without physical-out", async () => {
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
    sku: "REP",
    label: "rep",
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
  const orderId = (
    await request(app)
      .post("/api/v1/app/digital-metals/redemption/orders")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Idempotency-Key", randomUUID())
      .send({
        quoteId: quote.body.data.quoteId,
        termsVersionAccepted: quote.body.data.termsVersion,
        termsContentHashAccepted: quote.body.data.termsContentHash,
      })
  ).body.data.id;
  const adminToken = bearerFor(user);
  for (const step of ["accept", "packing", "dispatch"]) {
    const row = await DigitalMetalRedemptionOrder.findById(orderId).lean();
    const body =
      step === "accept"
        ? { expectedVersion: row.version, fulfilmentBranchId: branch._id }
        : step === "dispatch"
          ? { expectedVersion: row.version, carrier: "Manual", trackingReference: "X" }
          : { expectedVersion: row.version };
    const res = await request(app)
      .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/${step}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Idempotency-Key", randomUUID())
      .send(body);
    assert.equal(res.status, 200, step);
  }
  const beforeInv = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  const inv = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/investigation`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: beforeInv.version, reason: "Lost" });
  const rep = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/replacement-dispatch`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: inv.body.data.version, carrier: "Manual", trackingReference: "REP" });
  assert.equal(rep.status, 200);
  const wallet = await DigitalMetalWallet.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    metal: "GOLD",
    finenessPpm: 999_000,
  }).lean();
  assert.equal(Number(wallet.reservedUg), G2);
  assert.equal(await DigitalMetalPhysicalOutEvent.countDocuments({ redemptionOrderId: orderId }), 0);
});

test("replay webhook for winning attempt is no-op without refund case", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId } = await seedPaidPickupOrder({ tenant, branch, user, customer });
  const order = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  const { finalizeDigitalMetalRedemptionChargeSuccess } = await import(
    "../src/services/digital-metals-redemption-charge-finalize.service.js"
  );
  const { DigitalMetalRedemptionPaymentAttempt, DigitalMetalRedemptionChargeRefundCase } =
    await import("../src/models/index.js");
  let winning = order.successfulChargeAttemptId
    ? await DigitalMetalRedemptionPaymentAttempt.findById(order.successfulChargeAttemptId).lean()
    : null;
  if (!winning) {
    winning = await DigitalMetalRedemptionPaymentAttempt.create({
      _id: createId("dmrpay"),
      tenantId: tenant._id,
      orderId,
      customerId: customer._id,
      amountPaise: 0,
      merchantOrderId: createId("dmrpay"),
      idempotencyKey: randomUUID(),
      status: "SUCCEEDED",
      providerPaymentId: "txn-win",
    });
    await DigitalMetalRedemptionOrder.updateOne(
      { _id: orderId },
      { $set: { successfulChargeAttemptId: winning._id } },
    );
  }
  const a = await finalizeDigitalMetalRedemptionChargeSuccess({
    tenantId: tenant._id,
    merchantOrderId: winning._id,
    transactionId: winning.providerPaymentId ?? "txn-win",
    amountPaise: winning.amountPaise ?? order.chargeTotalPaise,
    source: "WEBHOOK",
  });
  const b = await finalizeDigitalMetalRedemptionChargeSuccess({
    tenantId: tenant._id,
    merchantOrderId: winning._id,
    transactionId: winning.providerPaymentId ?? "txn-win",
    amountPaise: winning.amountPaise ?? order.chargeTotalPaise,
    source: "POLL",
  });
  assert.equal(a.outcome, "ALREADY_SUCCESS");
  assert.equal(b.outcome, "ALREADY_SUCCESS");
  assert.equal(await DigitalMetalRedemptionChargeRefundCase.countDocuments({ redemptionOrderId: orderId }), 0);
});

test("duplicate charge on CHARGE_PAID order creates single refund case", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId } = await seedPaidPickupOrder({ tenant, branch, user, customer });
  await DigitalMetalRedemptionOrder.updateOne({ _id: orderId }, { $set: { chargeTotalPaise: 500_00 } });
  const { finalizeDigitalMetalRedemptionChargeSuccess } = await import(
    "../src/services/digital-metals-redemption-charge-finalize.service.js"
  );
  const { DigitalMetalRedemptionPaymentAttempt } = await import("../src/models/index.js");
  const attempt = await DigitalMetalRedemptionPaymentAttempt.create({
    _id: createId("dmrpay"),
    tenantId: tenant._id,
    orderId,
    customerId: customer._id,
    amountPaise: 500_00,
    merchantOrderId: createId("dmrpay"),
    idempotencyKey: randomUUID(),
    status: "INITIATED",
  });
  const a = await finalizeDigitalMetalRedemptionChargeSuccess({
    tenantId: tenant._id,
    merchantOrderId: attempt._id,
    transactionId: "dup-a",
    amountPaise: 500_00,
    source: "TEST",
  });
  assert.equal(a.outcome, "ADDITIONAL_CAPTURE_REVIEW");
  const b = await finalizeDigitalMetalRedemptionChargeSuccess({
    tenantId: tenant._id,
    merchantOrderId: attempt._id,
    transactionId: "dup-b",
    amountPaise: 500_00,
    source: "TEST",
  });
  assert.equal(b.outcome, "ALREADY_SUCCESS");
  const cases = await DigitalMetalRedemptionChargeRefundCase.find({ redemptionOrderId: orderId }).lean();
  assert.equal(cases.length, 1);
});

test("trading pause still allows fulfilment accept on paid order", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, adminToken } = await seedPaidPickupOrder({ tenant, branch, user, customer });
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "operations.digitalMetalsPaused": true, "operations.digitalMetalsPauseReason": "test" } },
  );
  const accept = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/accept`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: 1, fulfilmentBranchId: branch._id });
  assert.equal(accept.status, 200);
  assert.equal(accept.body.data.status, "FULFILMENT_ACCEPTED");
});

test("manual delivery completion requires attestation and is idempotent on physical-out", async () => {
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
    sku: "D2",
    label: "d",
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
  const orderId = (
    await request(app)
      .post("/api/v1/app/digital-metals/redemption/orders")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Idempotency-Key", randomUUID())
      .send({
        quoteId: quote.body.data.quoteId,
        termsVersionAccepted: quote.body.data.termsVersion,
        termsContentHashAccepted: quote.body.data.termsContentHash,
      })
  ).body.data.id;
  const adminToken = bearerFor(user);
  for (const step of ["accept", "packing", "dispatch"]) {
    const row = await DigitalMetalRedemptionOrder.findById(orderId).lean();
    const body =
      step === "dispatch"
        ? { expectedVersion: row.version, carrier: "Manual", trackingReference: "M1" }
        : step === "accept"
          ? { expectedVersion: row.version, fulfilmentBranchId: branch._id }
          : { expectedVersion: row.version };
    const stepRes = await request(app)
      .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/${step}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Idempotency-Key", randomUUID())
      .send(body);
    assert.equal(stepRes.status, 200, step);
  }
  const dispatched = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  const noAttest = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/complete-delivery`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: dispatched.version });
  assert.equal(noAttest.status, 400);

  const idem = randomUUID();
  const done = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/complete-delivery`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", idem)
    .send({ expectedVersion: dispatched.version, approverAttestation: true, evidenceUploadIds: ["u1"] });
  assert.equal(done.status, 200);
  const replayBody = {
    expectedVersion: dispatched.version,
    approverAttestation: true,
    evidenceUploadIds: ["u1"],
  };
  const replay = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/complete-delivery`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", idem)
    .send(replayBody);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers["x-idempotent-replay"], "true");
  assert.equal(await DigitalMetalPhysicalOutEvent.countDocuments({ redemptionOrderId: orderId }), 1);
});
