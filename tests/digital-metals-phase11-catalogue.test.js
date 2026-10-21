import { randomUUID } from "node:crypto";
process.env.NODE_ENV = "test";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import { createId } from "../src/lib/ids.js";
import {
  DigitalMetalRedemptionCatalogItem,
  DigitalMetalRedemptionOrder,
} from "../src/models/index.js";
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { PlanTier } from "../src/constants/enums.js";
import { Tenant } from "../src/models/index.js";

const app = createApp();

async function enableDigitalMetals(tenantId) {
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

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

test("catalogue patch updates gold and silver items with packaging and tax lines", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableDigitalMetals(tenant._id);
  const adminToken = bearerFor(user);
  const gold = await DigitalMetalRedemptionCatalogItem.create({
    _id: createId("dmrci"),
    tenantId: tenant._id,
    sku: "G2",
    label: "Gold 2g",
    metal: "GOLD",
    finenessPpm: 999_000,
    unitQuantityUg: 2 * UG_PER_G,
    mintingRule: { type: "FLAT_INR", amountPaise: 0 },
    deliveryFlatPaise: 0,
    packagingPaise: 0,
    taxLines: [],
    pickupEnabled: true,
    deliveryEnabled: true,
    active: true,
    version: 1,
  });
  const silver = await DigitalMetalRedemptionCatalogItem.create({
    _id: createId("dmrci"),
    tenantId: tenant._id,
    sku: "S2",
    label: "Silver 2g",
    metal: "SILVER",
    finenessPpm: 999_000,
    unitQuantityUg: 2 * UG_PER_G,
    mintingRule: { type: "NONE" },
    deliveryFlatPaise: 5000,
    packagingPaise: 100,
    taxLines: [{ code: "GST", label: "GST", base: "MINTING", ratePercent: 3 }],
    pickupEnabled: true,
    deliveryEnabled: false,
    active: true,
    version: 1,
  });

  const patchGold = await request(app)
    .patch(`/api/v1/admin/digital-metals/redemption/catalogue/${gold._id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      packagingPaise: 250,
      taxLines: [{ code: "GST", label: "GST", base: "MINTING", ratePercent: 3, active: true }],
    });
  assert.equal(patchGold.status, 200, JSON.stringify(patchGold.body));
  assert.equal(patchGold.body?.data?.packagingPaise, 250);

  const patchSilver = await request(app)
    .patch(`/api/v1/admin/digital-metals/redemption/catalogue/${silver._id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ deliveryFlatPaise: 0, packagingPaise: 0 });
  assert.equal(patchSilver.status, 200);
  assert.equal(patchSilver.body?.data?.packagingPaise, 0);
});

test("catalogue patch rejects disabling both fulfilment methods", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableDigitalMetals(tenant._id);
  const adminToken = bearerFor(user);
  const item = await DigitalMetalRedemptionCatalogItem.create({
    _id: createId("dmrci"),
    tenantId: tenant._id,
    sku: "X1",
    label: "Test",
    metal: "GOLD",
    finenessPpm: 999_000,
    unitQuantityUg: UG_PER_G,
    mintingRule: { type: "NONE" },
    pickupEnabled: true,
    deliveryEnabled: true,
    active: true,
    version: 1,
  });
  const bad = await request(app)
    .patch(`/api/v1/admin/digital-metals/redemption/catalogue/${item._id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ pickupEnabled: false, deliveryEnabled: false });
  assert.equal(bad.status, 422);
});

test("accepted order charge snapshot is preserved after catalogue edit", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await enableDigitalMetals(tenant._id);
  const adminToken = bearerFor(user);
  const item = await DigitalMetalRedemptionCatalogItem.create({
    _id: createId("dmrci"),
    tenantId: tenant._id,
    sku: "SNAP1",
    label: "Snap coin",
    metal: "GOLD",
    finenessPpm: 999_000,
    unitQuantityUg: UG_PER_G,
    mintingRule: { type: "FLAT_INR", amountPaise: 10000 },
    packagingPaise: 500,
    deliveryFlatPaise: 0,
    taxLines: [],
    pickupEnabled: true,
    deliveryEnabled: true,
    active: true,
    version: 2,
  });
  const orderId = createId("dmro");
  await DigitalMetalRedemptionOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customer._id,
    branchId: branch._id,
    quoteId: createId("dmrq"),
    catalogueItemId: item._id,
    catalogueVersion: 2,
    reservationId: createId("dmrs"),
    status: "FULFILMENT_ACCEPTED",
    metal: "GOLD",
    finenessPpm: 999_000,
    quantityUg: UG_PER_G,
    unitCount: 1,
    chargeTotalPaise: 10500,
    snapshot: {
      packagingPaise: 500,
      mintingPaise: 10000,
      deliveryPaise: 0,
      taxLines: [],
    },
    fulfilmentMode: "PICKUP",
    idempotencyKey: randomUUID(),
    quoteExpiresAt: new Date(Date.now() + 86_400_000),
    chargePaymentExpiresAt: new Date(Date.now() + 86_400_000),
    termsAcceptedAt: new Date(),
    version: 3,
  });

  await request(app)
    .patch(`/api/v1/admin/digital-metals/redemption/catalogue/${item._id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ packagingPaise: 9999, mintingRule: { type: "FLAT_INR", amountPaise: 1 } });

  const order = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  assert.equal(order.snapshot.packagingPaise, 500);
  assert.equal(order.snapshot.mintingPaise, 10000);
  assert.equal(order.catalogueVersion, 2);
  const cat = await DigitalMetalRedemptionCatalogItem.findById(item._id).lean();
  assert.equal(cat.packagingPaise, 9999);
  assert.ok((cat.version ?? 0) > 2);
});
