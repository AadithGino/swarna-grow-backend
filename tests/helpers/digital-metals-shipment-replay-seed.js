import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import request from "supertest";
import { PlanTier } from "../../src/constants/enums.js";
import { UG_PER_G } from "../../src/lib/digital-metals-quote-engine.js";
import { DigitalMetalRedemptionCatalogItem, DigitalMetalRedemptionOrder, Tenant } from "../../src/models/index.js";
import { bearerFor } from "./db.js";
import { makeTenantQuoteReady } from "./digital-metals-live-ready.js";
import { createId } from "../../src/lib/ids.js";
import { withTransaction } from "../../src/lib/transaction.js";
import { creditWalletForTest } from "../../src/services/digital-metals-ledger.service.js";

const G2 = 2 * UG_PER_G;

async function customerToken({ tenant, branch, customer }) {
  const { signAccessToken } = await import("../../src/services/token.service.js");
  const { Session } = await import("../../src/models/index.js");
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

export async function seedDeliveryOrderReadyToDispatch({ tenant, branch, user, customer, app }) {
  await Tenant.updateOne(
    { _id: tenant._id },
    {
      $set: {
        "subscription.planFeaturesSnapshot.digitalMetals": true,
        "subscription.tier": PlanTier.GROWTH,
        "operations.digitalMetalsEnabled": true,
      },
    },
  );
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
    sku: "SHIP-SEED",
    label: "2g coin",
    metal: "GOLD",
    finenessPpm: 999_000,
    unitQuantityUg: G2,
    mintingRule: { type: "NONE" },
    deliveryEnabled: true,
    pickupEnabled: false,
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
      fulfilmentMode: "DELIVERY",
      deliveryAddressId: createId("addr"),
    });
  assert.ok(quote.status >= 200 && quote.status < 300, `quote failed: ${quote.status} ${JSON.stringify(quote.body)}`);
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
  for (const step of ["accept", "packing"]) {
    const row = await DigitalMetalRedemptionOrder.findById(orderId).lean();
    const body =
      step === "accept"
        ? { expectedVersion: row.version, fulfilmentBranchId: branch._id }
        : { expectedVersion: row.version };
    const res = await request(app)
      .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/${step}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Idempotency-Key", randomUUID())
      .send(body);
    assert.equal(res.status, 200, step);
  }
  return { orderId, adminToken };
}
