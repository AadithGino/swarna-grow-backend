import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { PlanTier } from "../src/constants/enums.js";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import {
  DigitalMetalRedemptionCatalogItem,
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

const app = createApp();
const G2 = 2 * UG_PER_G;
const G5 = 5 * UG_PER_G;

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
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

async function seedGold5g({ tenant, customer }) {
  await withTransaction((session) =>
    creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G5,
      idempotencyKey: `seed-${randomUUID()}`,
    }),
  );
}

async function seedCatalog2gCoin({ tenant }) {
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
    pickupEnabled: true,
    deliveryEnabled: false,
    active: true,
  });
}

test("redeem 2g from 5g wallet reserves exactly 2g", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await seedGold5g({ tenant, customer });
  const item = await seedCatalog2gCoin({ tenant });
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
  assert.equal(quote.status, 201);
  const order = await request(app)
    .post("/api/v1/app/digital-metals/redemption/orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: quote.body.data.quoteId,
      termsVersionAccepted: quote.body.data.termsVersion,
      termsContentHashAccepted: quote.body.data.termsContentHash,
    });
  assert.equal(order.status, 201);
  const wallet = await DigitalMetalWallet.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    metal: "GOLD",
    finenessPpm: 999_000,
  }).lean();
  assert.equal(Number(wallet.reservedUg), G2);
  assert.equal(Number(wallet.heldUg) - Number(wallet.reservedUg), G5 - G2);
});

test("wrong redemption terms hash rejected before wallet reserve", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await seedGold5g({ tenant, customer });
  const item = await seedCatalog2gCoin({ tenant });
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
  assert.equal(quote.status, 201);
  const order = await request(app)
    .post("/api/v1/app/digital-metals/redemption/orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: quote.body.data.quoteId,
      termsVersionAccepted: quote.body.data.termsVersion,
      termsContentHashAccepted: "0".repeat(64),
    });
  assert.equal(order.status, 422);
  assert.equal(order.body.error?.code, "TERMS_NOT_ACCEPTED");
  const wallet = await DigitalMetalWallet.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    metal: "GOLD",
    finenessPpm: 999_000,
  }).lean();
  assert.equal(Number(wallet.reservedUg), 0);
});

test("zero-charge redemption skips payment path", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await seedGold5g({ tenant, customer });
  const item = await DigitalMetalRedemptionCatalogItem.create({
    _id: createId("dmrci"),
    tenantId: tenant._id,
    sku: "FREE-MINT",
    label: "Promo coin",
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
  const order = await request(app)
    .post("/api/v1/app/digital-metals/redemption/orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: quote.body.data.quoteId,
      termsVersionAccepted: quote.body.data.termsVersion,
      termsContentHashAccepted: quote.body.data.termsContentHash,
    });
  assert.equal(order.status, 201);
  assert.equal(order.body.data.status, "CHARGE_PAID");
});

test("disabled catalogue item rejected at quote", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await seedGold5g({ tenant, customer });
  const item = await seedCatalog2gCoin({ tenant });
  await DigitalMetalRedemptionCatalogItem.updateOne({ _id: item._id }, { $set: { active: false } });
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
  assert.equal(quote.status, 409);
});
