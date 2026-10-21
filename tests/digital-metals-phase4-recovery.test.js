import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
import { createApp } from "../src/app.js";
import { PlanTier } from "../src/constants/enums.js";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import { Tenant, DigitalMetalBuyOrder, DigitalMetalBuyPaymentAttempt } from "../src/models/index.js";
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
test.afterEach(async () => {
  const { clearDigitalMetalBuyFinalizeTestHooksForTests } = await import(
    "../src/lib/digital-metals-buy-finalize-test-hooks.js"
  );
  clearDigitalMetalBuyFinalizeTestHooksForTests();
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

test("credit recovery after simulated finalize pause credits exactly once", async () => {
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
      termsVersionAccepted: quote.body.data.termsVersion,
      termsContentHashAccepted: quote.body.data.termsContentHash,
    });
  await request(app)
    .post(`/api/v1/app/digital-metals/buy-orders/${order.body.data.id}/payment-intents`)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ redirectUrl: "https://example.com/return" });

  const { armPauseBeforeDigitalMetalBuyCreditForTests, clearDigitalMetalBuyFinalizeTestHooksForTests } =
    await import("../src/lib/digital-metals-buy-finalize-test-hooks.js");
  armPauseBeforeDigitalMetalBuyCreditForTests();
  const { completeTestHarnessBuyPayment } = await import(
    "../src/services/digital-metals-buy-payment.service.js"
  );
  await assert.rejects(
    () =>
      completeTestHarnessBuyPayment({
        auth: { id: customer._id, tenantId: tenant._id },
        params: { orderId: order.body.data.id },
        body: { outcome: "COMPLETED" },
      }),
    /TEST_PAUSE_BEFORE_BUY_CREDIT/,
  );
  clearDigitalMetalBuyFinalizeTestHooksForTests();

  await DigitalMetalBuyOrder.updateOne(
    { _id: order.body.data.id },
    {
      $set: {
        status: "PAYMENT_VERIFIED",
        successfulPaymentAttemptId: (
          await DigitalMetalBuyPaymentAttempt.findOne({ orderId: order.body.data.id })
        )?._id,
      },
    },
  );
  const { recoverDigitalMetalBuyOrderCredit } = await import(
    "../src/services/digital-metals-buy-finalize.service.js"
  );
  const r1 = await recoverDigitalMetalBuyOrderCredit(order.body.data.id, tenant._id);
  const r2 = await recoverDigitalMetalBuyOrderCredit(order.body.data.id, tenant._id);
  assert.equal(r1.outcome, "CREDITED");
  assert.equal(r2.outcome, "ALREADY_CREDITED");
  const portfolio = await request(app)
    .get("/api/v1/app/digital-metals/portfolio")
    .set("Authorization", `Bearer ${token}`);
  assert.ok(Number(portfolio.body.data.items[0]?.heldUg) >= UG_PER_G);
});

test("invoice outbox dispatch is idempotent", async () => {
  const { tenant, branch } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const orderId = createId("dmbo");
  await DigitalMetalBuyOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customer._id,
    branchId: branch._id,
    quoteId: createId("dmq"),
    status: "CREDITED",
    metal: "GOLD",
    finenessPpm: 999000,
    quantityUg: UG_PER_G,
    totalPayablePaise: 606_000,
    quoteExpiresAt: new Date(Date.now() + 86_400_000),
    paymentAcceptanceExpiresAt: new Date(Date.now() + 86_400_000),
    termsAcceptedAt: new Date(),
    idempotencyKey: randomUUID(),
    snapshot: { totalPayablePaise: 606_000, taxLines: [] },
    creditedAt: new Date(),
  });
  const { enqueueDigitalMetalOutboxEvent, DIGITAL_METAL_OUTBOX_TOPICS } = await import(
    "../src/lib/digital-metals-outbox.js"
  );
  await enqueueDigitalMetalOutboxEvent({
    tenantId: tenant._id,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_INVOICE_REQUEST,
    key: `${orderId}:invoice`,
    payload: { orderId },
  });
  const { runDigitalMetalOutboxDispatch } = await import(
    "../src/services/digital-metals-outbox-dispatch.service.js"
  );
  await runDigitalMetalOutboxDispatch();
  await runDigitalMetalOutboxDispatch();
  const fresh = await DigitalMetalBuyOrder.findById(orderId).lean();
  assert.equal(fresh.invoiceStatus, "READY");
  assert.ok(fresh.invoiceUploadId);
});

test("test-harness completion denied when harness is off", async () => {
  const prevHarness = process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS;
  process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "false";
  try {
    const { completeTestHarnessBuyPayment } = await import(
      "../src/services/digital-metals-buy-payment.service.js"
    );
    await assert.rejects(
      () =>
        completeTestHarnessBuyPayment({
          auth: { id: "cus_x", tenantId: "tnt_x" },
          params: { orderId: "dmbo_x" },
          body: { outcome: "COMPLETED" },
        }),
      (err) => err?.code === "RESOURCE_NOT_FOUND",
    );
  } finally {
    process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = prevHarness;
  }
});
