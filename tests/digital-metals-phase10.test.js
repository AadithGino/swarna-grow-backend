import { randomUUID } from "node:crypto";
process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { MessageType, PlanTier } from "../src/constants/enums.js";
import {
  DigitalMetalBuyOrder,
  DigitalMetalOutboxEvent,
  Message,
  Tenant,
} from "../src/models/index.js"; // DigitalMetalBuyOrder used in credited flow assertion
import { runDigitalMetalOutboxDispatch } from "../src/services/digital-metals-outbox-dispatch.service.js";
import { DIGITAL_METAL_OUTBOX_TOPICS } from "../src/lib/digital-metals-outbox.js";
import { digitalMetalInboxEventKey } from "../src/lib/digital-metals-customer-notice.js";
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

async function customerBearer({ tenant, branch, customer }) {
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
  return `Bearer ${signAccessToken({
    id: customer._id,
    type: "CUSTOMER",
    tenantId: tenant._id,
    branchId: branch._id,
    role: "CUSTOMER",
    permissions: [],
    deviceId: "cust",
    securityVersion: 0,
    sessionId: session._id,
  })}`;
}

async function creditBuyOrderViaHarness() {
  const { tenant, branch, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  await configureTenantPhonePe(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerBearer({ tenant, branch, customer });
  const quote = await request(app)
    .post("/api/v1/app/digital-metals/quotes/buy")
    .set("Authorization", token)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      metal: "GOLD",
      finenessPpm: 999_000,
      inputMode: "BUDGET_INR",
      budgetPaise: 600_000,
    });
  assert.equal(quote.status, 201);
  const order = await request(app)
    .post("/api/v1/app/digital-metals/buy-orders")
    .set("Authorization", token)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: quote.body.data.quoteId,
      termsVersionAccepted: "2026-10-01",
      termsContentHashAccepted: quote.body.data.termsContentHash,
    });
  assert.equal(order.status, 201);
  const orderId = order.body.data.id;
  await request(app)
    .post(`/api/v1/app/digital-metals/buy-orders/${orderId}/payment-intents`)
    .set("Authorization", token)
    .set("X-Idempotency-Key", randomUUID())
    .send({ redirectUrl: "https://example.com/return" });
  const { completeTestHarnessBuyPayment } = await import(
    "../src/services/digital-metals-buy-payment.service.js"
  );
  await completeTestHarnessBuyPayment({
    auth: { id: customer._id, tenantId: tenant._id },
    params: { orderId },
    body: { outcome: "COMPLETED" },
  });
  return { tenant, customer, orderId, token };
}

test("purchase credited outbox creates one inbox message with tenant deep link (real Mongo)", async () => {
  const { tenant, customer, orderId } = await creditBuyOrderViaHarness();
  const order = await DigitalMetalBuyOrder.findById(orderId).lean();
  assert.equal(order.status, "CREDITED");
  const outbox = await DigitalMetalOutboxEvent.findOne({
    tenantId: tenant._id,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_CREDITED,
    key: orderId,
  }).lean();
  assert.ok(outbox);

  await runDigitalMetalOutboxDispatch();
  await runDigitalMetalOutboxDispatch();

  const inboxKey = digitalMetalInboxEventKey("purchase.credited", orderId);
  const messages = await Message.find({
    tenantId: tenant._id,
    customerId: customer._id,
    "templateParams.inboxEventKey": inboxKey,
  }).lean();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.DIGITAL_METAL_PURCHASE_CREDITED);
  assert.match(String(messages[0].templateParams.deepLink), /\/digital-metals\/order\//);
  assert.doesNotMatch(String(messages[0].templateParams.body), /presign|amazonaws|mock-storage/i);
});

test("uncredited order outbox does not create success notification", async () => {
  const { tenant, branch } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const orderId = createId("dmbo");
  await DigitalMetalOutboxEvent.create({
    _id: createId("dmobx"),
    tenantId: tenant._id,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_CREDITED,
    key: orderId,
    payload: { orderId, customerId: customer._id },
    status: "PENDING",
  });
  const result = await runDigitalMetalOutboxDispatch();
  assert.ok(result);
  const count = await Message.countDocuments({
    tenantId: tenant._id,
    type: MessageType.DIGITAL_METAL_PURCHASE_CREDITED,
  });
  assert.equal(count, 0);
});

test("separate buy orders produce separate inbox events", async () => {
  const ctx = await creditBuyOrderViaHarness();
  const quote2 = await request(app)
    .post("/api/v1/app/digital-metals/quotes/buy")
    .set("Authorization", ctx.token)
    .set("X-Idempotency-Key", randomUUID())
    .send({ metal: "GOLD", finenessPpm: 999_000, inputMode: "BUDGET_INR", budgetPaise: 600_000 });
  const order2 = await request(app)
    .post("/api/v1/app/digital-metals/buy-orders")
    .set("Authorization", ctx.token)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: quote2.body.data.quoteId,
      termsVersionAccepted: "2026-10-01",
      termsContentHashAccepted: quote2.body.data.termsContentHash,
    });
  await request(app)
    .post(`/api/v1/app/digital-metals/buy-orders/${order2.body.data.id}/payment-intents`)
    .set("Authorization", ctx.token)
    .set("X-Idempotency-Key", randomUUID())
    .send({ redirectUrl: "https://example.com/return" });
  const { completeTestHarnessBuyPayment } = await import(
    "../src/services/digital-metals-buy-payment.service.js"
  );
  await completeTestHarnessBuyPayment({
    auth: { id: ctx.customer._id, tenantId: ctx.tenant._id },
    params: { orderId: order2.body.data.id },
    body: { outcome: "COMPLETED" },
  });
  await runDigitalMetalOutboxDispatch();
  const messages = await Message.find({
    tenantId: ctx.tenant._id,
    type: MessageType.DIGITAL_METAL_PURCHASE_CREDITED,
  }).lean();
  assert.equal(messages.length, 2);
  const keys = new Set(messages.map((m) => m.templateParams.inboxEventKey));
  assert.equal(keys.size, 2);
  assert.notEqual(ctx.orderId, order2.body.data.id);
});

test("admin work-queue lists stuck outbox without secrets (real Mongo)", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const failedId = createId("dmobx");
  await DigitalMetalOutboxEvent.create({
    _id: failedId,
    tenantId: tenant._id,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.DOCUMENT_READY,
    key: "stuck:1",
    payload: { artifactId: "dmdoc_x", customerId: "cust_x" },
    status: "FAILED",
    lastError: "https://secret-bucket.s3.amazonaws.com/private/doc.pdf?sig=leak",
  });
  const res = await request(app)
    .get("/api/v1/admin/digital-metals/operations/work-queue")
    .set("Authorization", `Bearer ${bearerFor(user)}`);
  assert.equal(res.status, 200);
  const item = res.body.data.items.find((i) => i.id === failedId);
  assert.ok(item);
  assert.doesNotMatch(String(item.lastError), /amazonaws\.com/);
});
