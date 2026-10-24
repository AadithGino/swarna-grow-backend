import { randomUUID } from "node:crypto";
process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { PlanTier } from "../src/constants/enums.js";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import {
  hashDigitalMetalsOrderBody,
  resolveCustomerBoundIdempotencyReplay,
} from "../src/lib/digital-metals-customer-idempotency.js";
import { DigitalMetalSellOrder, Tenant } from "../src/models/index.js";
import {
  resetTestDb,
  seedCustomer,
  seedTenantUser,
  startTestDb,
  stopTestDb,
  bearerFor,
} from "./helpers/db.js";
import { makeTenantQuoteReady } from "./helpers/digital-metals-live-ready.js";
import { createId } from "../src/lib/ids.js";
import { signAccessToken } from "../src/services/token.service.js";
import { Session } from "../src/models/index.js";

const app = createApp();

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

async function customerBuyQuote(token) {
  const res = await request(app)
    .post("/api/v1/app/digital-metals/quotes/buy")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      metal: "GOLD",
      finenessPpm: 999000,
      inputMode: "BUDGET_INR",
      budgetPaise: 600_000,
    });
  assert.equal(res.status, 201);
  return res.body.data;
}

test("resolveCustomerBoundIdempotencyReplay hides other customers orders", () => {
  const body = {
    quoteId: "dmrq_a",
    termsVersionAccepted: "2026-10-01",
    termsContentHashAccepted: "abc",
  };
  const bodyHash = hashDigitalMetalsOrderBody(body);
  const order = {
    _id: "dmbo_1",
    customerId: "cust_a",
    quoteId: "dmrq_a",
    termsVersion: "2026-10-01",
    termsContentHash: "abc",
  };
  assert.throws(
    () =>
      resolveCustomerBoundIdempotencyReplay({
        order,
        customerId: "cust_b",
        body,
        bodyHash,
      }),
    (err) => err.statusCode === 404,
  );
});

test("resolveCustomerBoundIdempotencyReplay rejects payload mismatch", () => {
  const body = {
    quoteId: "dmrq_a",
    termsVersionAccepted: "2026-10-01",
    termsContentHashAccepted: "abc",
  };
  const bodyHash = hashDigitalMetalsOrderBody(body);
  const order = {
    customerId: "cust_a",
    quoteId: "dmrq_other",
    termsVersion: "2026-10-01",
    termsContentHash: "abc",
    creationBodyHash: hashDigitalMetalsOrderBody({
      quoteId: "dmrq_other",
      termsVersionAccepted: "2026-10-01",
      termsContentHashAccepted: "abc",
    }),
  };
  assert.throws(
    () =>
      resolveCustomerBoundIdempotencyReplay({
        order,
        customerId: "cust_a",
        body,
        bodyHash,
      }),
    (err) => err.code === "IDEMPOTENCY_KEY_REUSED",
  );
});

test("buy order idempotency is customer-bound and replays identical body", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  const customerA = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile: "+919900000101" });
  const customerB = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile: "+919900000102" });
  const tokenA = await customerToken({ tenant, branch, customer: customerA });
  const tokenB = await customerToken({ tenant, branch, customer: customerB });
  const quoteA = await customerBuyQuote(tokenA);
  const quoteB = await customerBuyQuote(tokenB);
  const sharedKey = "shared-buy-idem-key";

  const bodyA = {
    quoteId: quoteA.quoteId,
    termsVersionAccepted: quoteA.termsVersion,
    termsContentHashAccepted: quoteA.termsContentHash,
  };
  const first = await request(app)
    .post("/api/v1/app/digital-metals/buy-orders")
    .set("Authorization", `Bearer ${tokenA}`)
    .set("X-Idempotency-Key", sharedKey)
    .send(bodyA);
  assert.equal(first.status, 201);

  const replay = await request(app)
    .post("/api/v1/app/digital-metals/buy-orders")
    .set("Authorization", `Bearer ${tokenA}`)
    .set("X-Idempotency-Key", sharedKey)
    .send(bodyA);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.data.id, first.body.data.id);

  const otherCustomer = await request(app)
    .post("/api/v1/app/digital-metals/buy-orders")
    .set("Authorization", `Bearer ${tokenB}`)
    .set("X-Idempotency-Key", sharedKey)
    .send({
      quoteId: quoteB.quoteId,
      termsVersionAccepted: quoteB.termsVersion,
      termsContentHashAccepted: quoteB.termsContentHash,
    });
  assert.equal(otherCustomer.status, 404);
  assert.notEqual(otherCustomer.body.data?.id, first.body.data.id);

  const mismatch = await request(app)
    .post("/api/v1/app/digital-metals/buy-orders")
    .set("Authorization", `Bearer ${tokenA}`)
    .set("X-Idempotency-Key", sharedKey)
    .send({
      quoteId: quoteB.quoteId,
      termsVersionAccepted: quoteB.termsVersion,
      termsContentHashAccepted: quoteB.termsContentHash,
    });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error?.code, "IDEMPOTENCY_KEY_REUSED");
});

test("sell order idempotency is customer-bound", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  const customerA = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile: "+919900000201" });
  const customerB = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile: "+919900000202" });
  const tokenB = await customerToken({ tenant, branch, customer: customerB });

  const tenantRow = await Tenant.findById(tenant._id).lean();
  const termsVersion = tenantRow.operations.digitalMetalsTermsVersion;
  const termsHash = tenantRow.operations.digitalMetalsTermsContentHash;
  const sharedKey = "shared-sell-idem-key";
  const quoteIdA = createId("dmrq");
  const bodyB = {
    quoteId: createId("dmrq"),
    termsVersionAccepted: termsVersion,
    termsContentHashAccepted: termsHash,
  };
  const bodyA = {
    quoteId: quoteIdA,
    termsVersionAccepted: termsVersion,
    termsContentHashAccepted: termsHash,
  };
  await DigitalMetalSellOrder.create({
    _id: createId("dmso"),
    tenantId: tenant._id,
    customerId: customerA._id,
    branchId: branch._id,
    quoteId: quoteIdA,
    reservationId: createId("dmrs"),
    status: "RESERVED",
    metal: "GOLD",
    finenessPpm: 999_000,
    quantityUg: UG_PER_G,
    settlementPaise: 50_000,
    quoteExpiresAt: new Date(Date.now() + 86_400_000),
    termsVersion: bodyA.termsVersionAccepted,
    termsContentHash: bodyA.termsContentHashAccepted,
    termsAcceptedAt: new Date(),
    idempotencyKey: sharedKey,
    creationBodyHash: hashDigitalMetalsOrderBody(bodyA),
  });

  const otherCustomer = await request(app)
    .post("/api/v1/app/digital-metals/sell-orders")
    .set("Authorization", `Bearer ${tokenB}`)
    .set("X-Idempotency-Key", sharedKey)
    .send(bodyB);
  assert.equal(otherCustomer.status, 404);
});
