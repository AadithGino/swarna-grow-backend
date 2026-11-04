import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import request from "supertest";
import { PlanTier } from "../../src/constants/enums.js";
import { UG_PER_G } from "../../src/lib/digital-metals-quote-engine.js";
import { createId } from "../../src/lib/ids.js";
import { seal } from "../../src/lib/crypto.js";
import { signAccessToken } from "../../src/services/token.service.js";
import { withTransaction } from "../../src/lib/transaction.js";
import { creditWalletForTest } from "../../src/services/digital-metals-ledger.service.js";
import { DigitalMetalBankDestination, Session, Tenant } from "../../src/models/index.js";
import { bearerFor } from "./db.js";
import { makeTenantQuoteReady } from "./digital-metals-live-ready.js";

export async function enableDigitalMetalsPlan(tenantId) {
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

export async function customerToken({ tenant, branch, customer }) {
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

async function seedWalletGold({ tenant, customer, quantityUg = UG_PER_G }) {
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

async function activeBankDestination({ tenant, customer }) {
  return DigitalMetalBankDestination.create({
    _id: createId("dmbd"),
    tenantId: tenant._id,
    customerId: customer._id,
    accountHolderName: "Test User",
    accountNumberSealed: seal("123456789012"),
    accountLast4: "9012",
    ifsc: "HDFC0001234",
    status: "ACTIVE",
    verifiedAt: new Date(),
  });
}

export async function sellThroughConfirm({ tenant, user, customer, app, quantityUg = UG_PER_G }) {
  await enableDigitalMetalsPlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await seedWalletGold({ tenant, customer, quantityUg });
  const token = await customerToken({ tenant, branch: { _id: customer.branchId }, customer });
  const quote = await request(app)
    .post("/api/v1/app/digital-metals/quotes/sell")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ metal: "GOLD", finenessPpm: 999000, quantityUg });
  assert.equal(quote.status, 201);
  const order = await request(app)
    .post("/api/v1/app/digital-metals/sell-orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: quote.body.data.quoteId,
      termsVersionAccepted: quote.body.data.termsVersion,
      termsContentHashAccepted: quote.body.data.termsContentHash,
    });
  assert.equal(order.status, 201);
  const dest = await activeBankDestination({ tenant, customer });
  const confirm = await request(app)
    .post(`/api/v1/app/digital-metals/sell-orders/${order.body.data.id}/confirm`)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ bankDestinationId: dest._id });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body?.error ?? {}));
  return {
    order: { ...order.body.data, ...confirm.body.data, version: confirm.body.data.version },
    dest,
    adminToken: bearerFor(user),
    customerToken: token,
  };
}
