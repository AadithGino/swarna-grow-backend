import test from "node:test";
import assert from "node:assert/strict";
import { CallbackType } from "@phonepe-pg/pg-sdk-node";
import { processWebhook } from "../src/workers/processors.js";
import { getOpsMetricsSnapshot } from "../src/lib/ops-metrics.js";
import { Alert, LedgerEntry, Payment, PaymentIntent, PaymentRefund, Scheme, WebhookEvent } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function seedPendingPayment({ tenant, branch }) {
  const paymentId = createId("payment");
  const intentId = createId("paymentIntent");
  const schemeId = createId("scheme");
  await Scheme.create({
    _id: schemeId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    planId: createId("schemePlan"),
    enrollmentNumber: "ENR-UNSUPPORTED",
    planSnapshot: { paymentPattern: "FIXED" },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installmentAmountPaise: 50_000,
    installments: [],
    positionVersion: 1,
    version: 1,
  });
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId,
    customerId: createId("customer"),
    amountPaise: 50_000,
    status: "PENDING",
    mode: "ONLINE_GATEWAY",
    source: "CUSTOMER_APP",
    receiptNumber: `PENDING-${paymentId}`,
  });
  await PaymentIntent.create({
    _id: intentId,
    tenantId: tenant._id,
    paymentId,
    amountPaise: 50_000,
    positionVersion: 1,
    status: "PENDING",
    version: 1,
  });
  return { paymentId, intentId, schemeId };
}

async function queueUnknownEvent(tenantId, payload, providerEventId) {
  const eventId = createId("webhook");
  await WebhookEvent.create({
    _id: eventId,
    tenantId,
    provider: "PHONEPE",
    providerEventId,
    status: "QUEUED",
    payload,
  });
  return eventId;
}

test("unknown PhonePe callback is terminal UNSUPPORTED with alert and no payment mutation", async () => {
  const { tenant, branch } = await seedTenantUser();
  const { paymentId } = await seedPendingPayment({ tenant, branch });
  const eventId = await queueUnknownEvent(
    tenant._id,
    { type: "PG_UNKNOWN_FUTURE_EVENT", payload: { amount: 50000 } },
    `pe-unknown-${createId("x")}`,
  );
  await processWebhook({ data: { webhookEventId: eventId }, attemptsMade: 0 });
  const event = await WebhookEvent.findById(eventId).lean();
  assert.equal(event.status, "UNSUPPORTED");
  assert.notEqual(event.status, "COMPLETED");
  assert.ok(await Alert.findOne({ tenantId: tenant._id, type: "GATEWAY_UNSUPPORTED_CALLBACK" }));
  assert.equal((await Payment.findById(paymentId).lean()).status, "PENDING");
  assert.equal(await LedgerEntry.countDocuments({ paymentId }), 0);
  assert.equal(await PaymentRefund.countDocuments({ paymentId }), 0);
});

test("unknown callback with valid-looking payment data does not finalize payment", async () => {
  const { tenant, branch } = await seedTenantUser();
  const { paymentId, intentId } = await seedPendingPayment({ tenant, branch });
  const eventId = await queueUnknownEvent(
    tenant._id,
    {
      type: "PG_UNKNOWN_FUTURE_EVENT",
      payload: {
        originalMerchantOrderId: intentId,
        amount: 50_000,
        paymentDetails: [{ state: "COMPLETED", transactionId: "txn-evil", amount: 50_000 }],
      },
    },
    `pe-evil-${intentId}`,
  );
  await processWebhook({ data: { webhookEventId: eventId }, attemptsMade: 0 });
  assert.equal((await WebhookEvent.findById(eventId).lean()).status, "UNSUPPORTED");
  assert.equal((await Payment.findById(paymentId).lean()).status, "PENDING");
});

test("sequential replay of unsupported webhook is idempotent", async () => {
  const { tenant } = await seedTenantUser();
  const providerEventId = `pe-unknown-replay-${createId("x")}`;
  const eventId = await queueUnknownEvent(
    tenant._id,
    { type: "PG_UNKNOWN_FUTURE_EVENT", payload: {} },
    providerEventId,
  );
  await processWebhook({ data: { webhookEventId: eventId }, attemptsMade: 0 });
  const beforeMetrics = getOpsMetricsSnapshot().counters["phonepe.webhook.unsupported"] ?? 0;
  await processWebhook({ data: { webhookEventId: eventId }, attemptsMade: 1 });
  const afterMetrics = getOpsMetricsSnapshot().counters["phonepe.webhook.unsupported"] ?? 0;
  assert.equal(beforeMetrics, afterMetrics);
  assert.equal(await Alert.countDocuments({ tenantId: tenant._id, type: "GATEWAY_UNSUPPORTED_CALLBACK" }), 1);
});

test("concurrent unsupported processing cannot flip status to COMPLETED", async () => {
  const { tenant } = await seedTenantUser();
  const eventId = await queueUnknownEvent(
    tenant._id,
    { type: "PG_UNKNOWN_FUTURE_EVENT", payload: { amount: 1 } },
    `pe-concurrent-${createId("x")}`,
  );
  await Promise.allSettled([
    processWebhook({ data: { webhookEventId: eventId }, id: "w1", attemptsMade: 0 }),
    processWebhook({ data: { webhookEventId: eventId }, id: "w2", attemptsMade: 0 }),
  ]);
  const event = await WebhookEvent.findById(eventId).lean();
  assert.equal(event.status, "UNSUPPORTED");
  assert.notEqual(event.status, "COMPLETED");
});

test("known completed callback path unchanged", async () => {
  const { tenant } = await seedTenantUser();
  const reference = createId("paymentIntent");
  const eventId = createId("webhook");
  await WebhookEvent.create({
    _id: eventId,
    tenantId: tenant._id,
    provider: "PHONEPE",
    providerEventId: `pe-${reference}`,
    status: "QUEUED",
    payload: {
      type: CallbackType.CHECKOUT_ORDER_COMPLETED,
      payload: {
        originalMerchantOrderId: reference,
        amount: 50000,
        paymentDetails: [{ state: "COMPLETED", transactionId: "txn-new" }],
      },
    },
  });
  await processWebhook({ data: { webhookEventId: eventId }, attemptsMade: 0 });
  assert.equal((await WebhookEvent.findById(eventId).lean()).status, "COMPLETED");
});

test("unsupported webhook is not requeued by replay helper", async () => {
  const { tenant } = await seedTenantUser();
  const eventId = createId("webhook");
  await WebhookEvent.create({
    _id: eventId,
    tenantId: tenant._id,
    provider: "PHONEPE",
    providerEventId: `pe-unsupported-${eventId}`,
    status: "UNSUPPORTED",
    processedAt: new Date(),
    payload: { type: "PG_UNKNOWN", payload: {} },
  });
  const { replayWebhookEvent } = await import("../src/services/webhook-event.service.js");
  const replayed = await replayWebhookEvent({ tenantId: tenant._id, webhookEventId: eventId });
  assert.equal(replayed, null);
});
