import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
import { createApp } from "../src/app.js";
import { PlanTier } from "../src/constants/enums.js";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import {
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
import { expireStaleRedemptionOrdersForTenant } from "../src/services/digital-metals-redemption-maintenance.service.js";
import { seedCustomerDeliveryAddress } from "./helpers/digital-metals-redemption-delivery-fixture.js";

const app = createApp();
const G2 = 2 * UG_PER_G;
const G4 = 4 * UG_PER_G;
const G5 = 5 * UG_PER_G;

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

async function seedGold({ tenant, customer, quantityUg }) {
  await withTransaction((session) =>
    creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg,
      idempotencyKey: `seed-${randomUUID()}`,
    }),
  );
}

async function seedCatalog2g({ tenant, overrides = {} }) {
  return DigitalMetalRedemptionCatalogItem.create({
    _id: createId("dmrci"),
    tenantId: tenant._id,
    sku: "GOLD-2G-COIN",
    label: "2g Gold Coin",
    metal: "GOLD",
    finenessPpm: 999_000,
    unitQuantityUg: G2,
    mintingRule: { type: "FLAT_INR", amountPaise: 500_00 },
    packagingPaise: 0,
    deliveryFlatPaise: 0,
    deliveryWaiveAboveTotalChargePaise: 600_00,
    pickupEnabled: true,
    deliveryEnabled: false,
    active: true,
    ...overrides,
  });
}

async function redemptionOrderFromCatalog({ token, branch, item }) {
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
  assert.equal(quote.status, 201, quote.body?.error?.message);
  const orderKey = randomUUID();
  const order = await request(app)
    .post("/api/v1/app/digital-metals/redemption/orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", orderKey)
    .send({
      quoteId: quote.body.data.quoteId,
      termsVersionAccepted: quote.body.data.termsVersion,
      termsContentHashAccepted: quote.body.data.termsContentHash,
    });
  return { quote: quote.body.data, order: order.body.data, orderKey };
}

test("concurrent sell vs redemption: no double spending from 5g", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await seedGold({ tenant, customer, quantityUg: G5 });
  const item = await seedCatalog2g({ tenant });
  const sellQuote = await request(app)
    .post("/api/v1/app/digital-metals/quotes/sell")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ metal: "GOLD", finenessPpm: 999000, quantityUg: G4 });
  assert.equal(sellQuote.status, 201);
  const redQuote = await request(app)
    .post("/api/v1/app/digital-metals/quotes/redemption")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      catalogueItemId: item._id,
      metal: "GOLD",
      finenessPpm: 999000,
      unitCount: 2,
      fulfilmentMode: "PICKUP",
      pickupBranchId: branch._id,
    });
  assert.equal(redQuote.status, 201);
  const [sellRes, redRes] = await Promise.all([
    request(app)
      .post("/api/v1/app/digital-metals/sell-orders")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Idempotency-Key", randomUUID())
      .send({
        quoteId: sellQuote.body.data.quoteId,
        termsVersionAccepted: sellQuote.body.data.termsVersion,
        termsContentHashAccepted: sellQuote.body.data.termsContentHash,
      }),
    request(app)
      .post("/api/v1/app/digital-metals/redemption/orders")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Idempotency-Key", randomUUID())
      .send({
        quoteId: redQuote.body.data.quoteId,
        termsVersionAccepted: redQuote.body.data.termsVersion,
        termsContentHashAccepted: redQuote.body.data.termsContentHash,
      }),
  ]);
  const ok = [sellRes.status, redRes.status].filter((s) => s === 201).length;
  assert.equal(ok, 1);
});

test("wrong fineness and invalid pickup branch rejected", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await seedGold({ tenant, customer, quantityUg: G5 });
  const item = await seedCatalog2g({ tenant });
  const wrongFineness = await request(app)
    .post("/api/v1/app/digital-metals/quotes/redemption")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      catalogueItemId: item._id,
      metal: "GOLD",
      finenessPpm: 995000,
      unitCount: 1,
      fulfilmentMode: "PICKUP",
      pickupBranchId: branch._id,
    });
  assert.equal(wrongFineness.status, 400);
  const badBranch = await request(app)
    .post("/api/v1/app/digital-metals/quotes/redemption")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      catalogueItemId: item._id,
      metal: "GOLD",
      finenessPpm: 999000,
      unitCount: 1,
      fulfilmentMode: "PICKUP",
      pickupBranchId: createId("branch"),
    });
  assert.notEqual(badBranch.status, 201);
});

test("delivery waiver applies when charge total meets threshold", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await seedGold({ tenant, customer, quantityUg: G5 });
  const item = await DigitalMetalRedemptionCatalogItem.create({
    _id: createId("dmrci"),
    tenantId: tenant._id,
    sku: "DEL-WAIVE",
    label: "Deliver coin",
    metal: "GOLD",
    finenessPpm: 999_000,
    unitQuantityUg: G2,
    mintingRule: { type: "FLAT_INR", amountPaise: 650_00 },
    deliveryFlatPaise: 50_00,
    deliveryWaiveAboveTotalChargePaise: 600_00,
    pickupEnabled: false,
    deliveryEnabled: true,
    active: true,
  });
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
  assert.equal(quote.status, 201);
  assert.equal(quote.body.data.totalChargePaise, 650_00);
  assert.equal(quote.body.data.deliveryPaise, 0);
});

test("duplicate redemption order creation is idempotent", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await seedGold({ tenant, customer, quantityUg: G5 });
  const item = await seedCatalog2g({ tenant });
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
  const key = randomUUID();
  const body = {
    quoteId: quote.body.data.quoteId,
    termsVersionAccepted: quote.body.data.termsVersion,
    termsContentHashAccepted: quote.body.data.termsContentHash,
  };
  const a = await request(app)
    .post("/api/v1/app/digital-metals/redemption/orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", key)
    .send(body);
  const b = await request(app)
    .post("/api/v1/app/digital-metals/redemption/orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", key)
    .send(body);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.body.data.id, b.body.data.id);
});

test("late charge success after reservation release enters refund review", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await seedGold({ tenant, customer, quantityUg: G5 });
  const item = await seedCatalog2g({ tenant });
  const { order } = await redemptionOrderFromCatalog({ token, branch, item });
  assert.equal(order.status, "CHARGE_PENDING");
  await DigitalMetalRedemptionOrder.updateOne(
    { _id: order.id },
    { $set: { chargePaymentExpiresAt: new Date(Date.now() - 60_000) } },
  );
  await expireStaleRedemptionOrdersForTenant(tenant._id, order.id);
  const expired = await DigitalMetalRedemptionOrder.findById(order.id).lean();
  assert.equal(expired.status, "EXPIRED");
  const { finalizeDigitalMetalRedemptionChargeSuccess } = await import(
    "../src/services/digital-metals-redemption-charge-finalize.service.js"
  );
  const { DigitalMetalRedemptionPaymentAttempt } = await import("../src/models/index.js");
  const attempt = await DigitalMetalRedemptionPaymentAttempt.create({
    _id: createId("dmrpay"),
    tenantId: tenant._id,
    orderId: order.id,
    customerId: customer._id,
    amountPaise: expired.chargeTotalPaise,
    merchantOrderId: createId("dmrpay"),
    idempotencyKey: randomUUID(),
    status: "INITIATED",
  });
  const fin = await finalizeDigitalMetalRedemptionChargeSuccess({
    tenantId: tenant._id,
    merchantOrderId: attempt._id,
    transactionId: "late-txn",
    amountPaise: attempt.amountPaise,
    source: "TEST",
  });
  assert.equal(fin.outcome, "LATE_CHARGE_REVIEW");
  const after = await DigitalMetalRedemptionOrder.findById(order.id).lean();
  assert.equal(after.status, "REFUND_REVIEW");
});

test("tenant pause does not expire paid redemption reservation", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await seedGold({ tenant, customer, quantityUg: G5 });
  const item = await seedCatalog2g({ tenant, overrides: { mintingRule: { type: "NONE" } } });
  const { order } = await redemptionOrderFromCatalog({ token, branch, item });
  assert.equal(order.status, "CHARGE_PAID");
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "operations.digitalMetalsPaused": true, "operations.digitalMetalsPauseReason": "test" } },
  );
  await DigitalMetalRedemptionOrder.updateOne(
    { _id: order.id },
    { $set: { chargePaymentExpiresAt: new Date(Date.now() - 60_000), status: "CHARGE_PAID" } },
  );
  await expireStaleRedemptionOrdersForTenant(tenant._id, order.id);
  const still = await DigitalMetalRedemptionOrder.findById(order.id).lean();
  assert.equal(still.status, "CHARGE_PAID");
  const wallet = await DigitalMetalWallet.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    metal: "GOLD",
    finenessPpm: 999_000,
  }).lean();
  assert.equal(Number(wallet.reservedUg), G2);
});

test("redemption charge payment does not credit additional metal", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await seedGold({ tenant, customer, quantityUg: G5 });
  const item = await seedCatalog2g({ tenant });
  const { order } = await redemptionOrderFromCatalog({ token, branch, item });
  const before = await DigitalMetalWallet.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    metal: "GOLD",
    finenessPpm: 999_000,
  }).lean();
  const heldBefore = Number(before.heldUg);
  await request(app)
    .post(`/api/v1/app/digital-metals/redemption/orders/${order.id}/test-harness/complete-payment`)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ outcome: "COMPLETED" });
  const after = await DigitalMetalWallet.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    metal: "GOLD",
    finenessPpm: 999_000,
  }).lean();
  assert.equal(Number(after.heldUg), heldBefore);
  assert.equal(Number(after.reservedUg), G2);
});
