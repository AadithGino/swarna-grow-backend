import { randomUUID } from "node:crypto";
process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { PlanTier } from "../src/constants/enums.js";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import { Tenant } from "../src/models/index.js";
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

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
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

test("full buy flow credits wallet without physical stock (test harness)", async () => {
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
      termsVersionAccepted: "2026-10-01",
      termsContentHashAccepted: quote.body.data.termsContentHash,
    });
  assert.equal(order.status, 201);
  const pay = await request(app)
    .post(`/api/v1/app/digital-metals/buy-orders/${order.body.data.id}/payment-intents`)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ redirectUrl: "https://example.com/return" });
  assert.equal(pay.status, 201);
  const { completeTestHarnessBuyPayment } = await import(
    "../src/services/digital-metals-buy-payment.service.js"
  );
  const complete = await completeTestHarnessBuyPayment({
    auth: { id: customer._id, tenantId: tenant._id },
    params: { orderId: order.body.data.id },
    body: { outcome: "COMPLETED" },
  });
  assert.equal(complete.orderStatus, "CREDITED");
  const portfolio = await request(app)
    .get("/api/v1/app/digital-metals/portfolio")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(portfolio.status, 200);
  assert.ok(Number(portfolio.body.data.items[0]?.heldUg) >= UG_PER_G);
});

test("admin preview quote cannot be accepted as buy order", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  await configureTenantPhonePe(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  const adminToken = bearerFor(user);
  const preview = await request(app)
    .post("/api/v1/admin/digital-metals/quotes/preview")
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      side: "BUY",
      metal: "GOLD",
      finenessPpm: 999000,
      inputMode: "BUDGET_INR",
      budgetPaise: 600_000,
    });
  assert.equal(preview.status, 201);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const cToken = await customerToken({ tenant, branch, customer });
  const res = await request(app)
    .post("/api/v1/app/digital-metals/buy-orders")
    .set("Authorization", `Bearer ${cToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: preview.body.data.quoteId,
      termsVersionAccepted: "2026-10-01",
      termsContentHashAccepted: "deadbeef",
    });
  assert.ok(res.status === 400 || res.status === 422);
});

test("duplicate webhook finalization credits once", async () => {
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
    .send({ metal: "GOLD", finenessPpm: 999000, inputMode: "BUDGET_INR", budgetPaise: 600_000 });
  const order = await request(app)
    .post("/api/v1/app/digital-metals/buy-orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: quote.body.data.quoteId,
      termsVersionAccepted: "2026-10-01",
      termsContentHashAccepted: quote.body.data.termsContentHash,
    });
  await request(app)
    .post(`/api/v1/app/digital-metals/buy-orders/${order.body.data.id}/payment-intents`)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ redirectUrl: "https://example.com/return" });
  const { completeTestHarnessBuyPayment } = await import(
    "../src/services/digital-metals-buy-payment.service.js"
  );
  await completeTestHarnessBuyPayment({
    auth: { id: customer._id, tenantId: tenant._id },
    params: { orderId: order.body.data.id },
    body: { outcome: "COMPLETED" },
  });
  const { finalizeDigitalMetalBuyPaymentSuccess } = await import(
    "../src/services/digital-metals-buy-finalize.service.js"
  );
  const attempt = await import("../src/models/index.js").then((m) =>
    m.DigitalMetalBuyPaymentAttempt.findOne({ orderId: order.body.data.id }).lean(),
  );
  await finalizeDigitalMetalBuyPaymentSuccess({
    tenantId: tenant._id,
    merchantOrderId: attempt.merchantOrderId ?? attempt._id,
    transactionId: "dup-tx-2",
    amountPaise: order.body.data.totalPayablePaise,
    currency: "INR",
    providerPayload: {},
  });
  const detail = await request(app)
    .get(`/api/v1/app/digital-metals/buy-orders/${order.body.data.id}`)
    .set("Authorization", `Bearer ${token}`);
  assert.equal(detail.body.data.status, "CREDITED");
});

async function seedBuyQuote({ token, budgetPaise = 600_000 }) {
  const quote = await request(app)
    .post("/api/v1/app/digital-metals/quotes/buy")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      metal: "GOLD",
      finenessPpm: 999000,
      inputMode: "BUDGET_INR",
      budgetPaise,
    });
  assert.equal(quote.status, 201);
  return quote.body.data;
}

test("expired quote rejected at order acceptance", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const q = await seedBuyQuote({ token });
  const { DigitalMetalQuote } = await import("../src/models/index.js");
  await DigitalMetalQuote.updateOne({ _id: q.quoteId }, { $set: { expiresAt: new Date(Date.now() - 60_000) } });
  const res = await request(app)
    .post("/api/v1/app/digital-metals/buy-orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: q.quoteId,
      termsVersionAccepted: q.termsVersion,
      termsContentHashAccepted: q.termsContentHash,
    });
  assert.equal(res.status, 409);
  assert.equal(res.body.error?.code, "QUOTE_EXPIRED");
});

test("wrong terms hash rejected", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const q = await seedBuyQuote({ token });
  const res = await request(app)
    .post("/api/v1/app/digital-metals/buy-orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: q.quoteId,
      termsVersionAccepted: q.termsVersion,
      termsContentHashAccepted: "0".repeat(64),
    });
  assert.equal(res.status, 422);
});

test("cross-customer quote rejected", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  const c1 = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile: "+918800000011" });
  const c2 = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile: "+918800000022" });
  const t1 = await customerToken({ tenant, branch, customer: c1 });
  const t2 = await customerToken({ tenant, branch, customer: c2 });
  const q = await seedBuyQuote({ token: t1 });
  const res = await request(app)
    .post("/api/v1/app/digital-metals/buy-orders")
    .set("Authorization", `Bearer ${t2}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: q.quoteId,
      termsVersionAccepted: q.termsVersion,
      termsContentHashAccepted: q.termsContentHash,
    });
  assert.equal(res.status, 403);
});

test("buy order create is idempotent by X-Idempotency-Key", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const q = await seedBuyQuote({ token });
  const idem = randomUUID();
  const body = {
    quoteId: q.quoteId,
    termsVersionAccepted: q.termsVersion,
    termsContentHashAccepted: q.termsContentHash,
  };
  const a = await request(app)
    .post("/api/v1/app/digital-metals/buy-orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", idem)
    .send(body);
  const b = await request(app)
    .post("/api/v1/app/digital-metals/buy-orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", idem)
    .send(body);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.body.data.id, b.body.data.id);
});

test("verified payment with wrong amount does not credit", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  await configureTenantPhonePe(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const q = await seedBuyQuote({ token });
  const order = await request(app)
    .post("/api/v1/app/digital-metals/buy-orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: q.quoteId,
      termsVersionAccepted: q.termsVersion,
      termsContentHashAccepted: q.termsContentHash,
    });
  await request(app)
    .post(`/api/v1/app/digital-metals/buy-orders/${order.body.data.id}/payment-intents`)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ redirectUrl: "https://example.com/return" });
  const attempt = await import("../src/models/index.js").then((m) =>
    m.DigitalMetalBuyPaymentAttempt.findOne({ orderId: order.body.data.id }).lean(),
  );
  const { finalizeDigitalMetalBuyPaymentSuccess } = await import(
    "../src/services/digital-metals-buy-finalize.service.js"
  );
  const bad = await finalizeDigitalMetalBuyPaymentSuccess({
    tenantId: tenant._id,
    merchantOrderId: attempt.merchantOrderId ?? attempt._id,
    transactionId: "bad-amt",
    amountPaise: 1,
    currency: "INR",
    providerPayload: {},
  });
  assert.equal(bad.outcome, "AMOUNT_MISMATCH");
  const detail = await request(app)
    .get(`/api/v1/app/digital-metals/buy-orders/${order.body.data.id}`)
    .set("Authorization", `Bearer ${token}`);
  assert.notEqual(detail.body.data.status, "CREDITED");
});
