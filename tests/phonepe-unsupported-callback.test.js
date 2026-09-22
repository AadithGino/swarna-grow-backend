import test from "node:test";
import assert from "node:assert/strict";
import { CallbackType } from "@phonepe-pg/pg-sdk-node";
import { processWebhook } from "../src/workers/processors.js";
import { Alert, LedgerEntry, Payment, PaymentIntent, PaymentRefund, WebhookEvent } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function seedPendingPayment({ tenant, branch }) {
  const paymentId = createId("payment");
  const intentId = createId("paymentIntent");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: createId("scheme"),
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
  return { paymentId, intentId };
}

test("unknown PhonePe callback is terminal UNSUPPORTED with alert and no payment mutation", async () => {
  const { tenant, branch } = await seedTenantUser();
  const { paymentId } = await seedPendingPayment({ tenant, branch });
  const eventId = createId("webhook");
  await WebhookEvent.create({
    _id: eventId,
    tenantId: tenant._id,
    provider: "PHONEPE",
    providerEventId: `pe-unknown-${eventId}`,
    status: "QUEUED",
    payload: { type: "PG_UNKNOWN_FUTURE_EVENT", payload: { amount: 50000 } },
  });
  await processWebhook({ data: { webhookEventId: eventId }, attemptsMade: 0 });
  const event = await WebhookEvent.findById(eventId).lean();
  assert.equal(event.status, "UNSUPPORTED");
  assert.notEqual(event.status, "COMPLETED");
  const alert = await Alert.findOne({ tenantId: tenant._id, type: "GATEWAY_UNSUPPORTED_CALLBACK" }).lean();
  assert.ok(alert);
  const payment = await Payment.findById(paymentId).lean();
  assert.equal(payment.status, "PENDING");
  assert.equal(await LedgerEntry.countDocuments({ paymentId }), 0);
  assert.equal(await PaymentRefund.countDocuments({ paymentId }), 0);
});

test("unsupported callback replay is idempotent", async () => {
  const { tenant } = await seedTenantUser();
  const eventId = createId("webhook");
  await WebhookEvent.create({
    _id: eventId,
    tenantId: tenant._id,
    provider: "PHONEPE",
    providerEventId: `pe-unknown-replay-${eventId}`,
    status: "UNSUPPORTED",
    processedAt: new Date(),
    payload: { type: "PG_UNKNOWN_FUTURE_EVENT", payload: {} },
  });
  await processWebhook({ data: { webhookEventId: eventId }, attemptsMade: 0 });
  assert.equal(await Alert.countDocuments({ tenantId: tenant._id, type: "GATEWAY_UNSUPPORTED_CALLBACK" }), 0);
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
  const event = await WebhookEvent.findById(eventId).lean();
  assert.equal(event.status, "COMPLETED");
});
