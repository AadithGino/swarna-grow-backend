import test from "node:test";
import assert from "node:assert/strict";
import { CallbackType } from "@phonepe-pg/pg-sdk-node";
import { processWebhook } from "../src/workers/processors.js";
import { Alert, PaymentIntent, WebhookEvent } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("sdk CHECKOUT_ORDER_COMPLETED webhook with unmatched reference creates alert", async () => {
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
  const alert = await Alert.findOne({ tenantId: tenant._id, type: "GATEWAY_WEBHOOK_UNMATCHED" }).lean();
  assert.ok(alert);
  assert.equal(alert.severity, "CRITICAL");
});

test("sdk CHECKOUT_ORDER_FAILED webhook scopes payment intent lookup to event tenant", async () => {
  const { tenant: tenantA, branch: branchA } = await seedTenantUser({ mobile: "+919711111111" });
  const { tenant: tenantB, branch: branchB } = await seedTenantUser({ mobile: "+919722222222" });
  const sharedReference = createId("paymentIntent");
  const { Payment } = await import("../src/models/index.js");
  const paymentA = createId("payment");
  const paymentB = createId("payment");
  const intentA = sharedReference;
  const intentB = createId("paymentIntent");
  await Payment.create({
    _id: paymentA,
    tenantId: tenantA._id,
    branchId: branchA._id,
    schemeId: createId("scheme"),
    customerId: createId("customer"),
    amountPaise: 50000,
    providerTransactionId: sharedReference,
    status: "PENDING",
    mode: "ONLINE_GATEWAY",
    source: "CUSTOMER_APP",
    receiptNumber: `PENDING-${paymentA}`,
  });
  await Payment.create({
    _id: paymentB,
    tenantId: tenantB._id,
    branchId: branchB._id,
    schemeId: createId("scheme"),
    customerId: createId("customer"),
    amountPaise: 75000,
    providerTransactionId: sharedReference,
    status: "PENDING",
    mode: "ONLINE_GATEWAY",
    source: "CUSTOMER_APP",
    receiptNumber: `PENDING-${paymentB}`,
  });
  await PaymentIntent.create({
    _id: intentA,
    tenantId: tenantA._id,
    paymentId: paymentA,
    schemeId: createId("scheme"),
    amountPaise: 50000,
    positionVersion: 1,
    status: "PENDING",
    version: 1,
  });
  await PaymentIntent.create({
    _id: intentB,
    tenantId: tenantB._id,
    paymentId: paymentB,
    schemeId: createId("scheme"),
    amountPaise: 75000,
    positionVersion: 1,
    status: "PENDING",
    version: 1,
  });
  const eventId = createId("webhook");
  await WebhookEvent.create({
    _id: eventId,
    tenantId: tenantA._id,
    provider: "PHONEPE",
    providerEventId: `pe-${sharedReference}-a`,
    status: "QUEUED",
    payload: {
      type: CallbackType.CHECKOUT_ORDER_FAILED,
      payload: {
        originalMerchantOrderId: sharedReference,
        amount: 50000,
        paymentDetails: [{ state: "FAILED", transactionId: "txn-a" }],
      },
    },
  });
  await processWebhook({ data: { webhookEventId: eventId }, attemptsMade: 0 });
  const afterA = await PaymentIntent.findById(intentA).lean();
  const afterB = await PaymentIntent.findById(intentB).lean();
  assert.equal(afterA.status, "FAILED");
  assert.equal(afterB.status, "PENDING");
});

test("sdk PG_REFUND_COMPLETED webhook completes without unmatched alert", async () => {
  const { tenant } = await seedTenantUser();
  const eventId = createId("webhook");
  await WebhookEvent.create({
    _id: eventId,
    tenantId: tenant._id,
    provider: "PHONEPE",
    providerEventId: "refund-1",
    status: "QUEUED",
    payload: {
      type: CallbackType.PG_REFUND_COMPLETED,
      payload: { orderId: "ord_refund", amount: 10000 },
    },
  });
  await processWebhook({ data: { webhookEventId: eventId }, attemptsMade: 0 });
  const alert = await Alert.findOne({ tenantId: tenant._id, type: "GATEWAY_WEBHOOK_UNMATCHED" }).lean();
  assert.equal(alert, null);
  const event = await WebhookEvent.findById(eventId).lean();
  assert.equal(event.status, "COMPLETED");
});
