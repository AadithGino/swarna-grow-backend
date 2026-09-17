import test from "node:test";
import assert from "node:assert/strict";
import { processWebhook } from "../src/workers/processors.js";
import { Alert, PaymentIntent, WebhookEvent } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("completed phonepe webhook with unmatched reference creates a critical alert", async () => {
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
      data: {
        merchantTransactionId: reference,
        transactionId: reference,
        state: "COMPLETED",
        amount: 50000,
      },
    },
  });
  await processWebhook({ data: { webhookEventId: eventId }, attemptsMade: 0 });
  const alert = await Alert.findOne({ tenantId: tenant._id, type: "GATEWAY_WEBHOOK_UNMATCHED" }).lean();
  assert.ok(alert);
  assert.equal(alert.severity, "CRITICAL");
  const event = await WebhookEvent.findById(eventId).lean();
  assert.equal(event.status, "COMPLETED");
});

test("phonepe failed webhook scopes payment intent lookup to event tenant", async () => {
  const { tenant: tenantA, branch: branchA } = await seedTenantUser({ mobile: "+919711111111" });
  const { tenant: tenantB, branch: branchB } = await seedTenantUser({ mobile: "+919722222222" });
  const sharedReference = "shared-provider-ref";
  const { Payment } = await import("../src/models/index.js");
  const paymentA = createId("payment");
  const paymentB = createId("payment");
  const intentA = createId("paymentIntent");
  const intentB = createId("paymentIntent");
  const schemeA = createId("scheme");
  const schemeB = createId("scheme");
  const customerA = createId("customer");
  const customerB = createId("customer");
  const paymentBase = {
    providerTransactionId: sharedReference,
    status: "PENDING",
    mode: "ONLINE_GATEWAY",
    source: "CUSTOMER_APP",
    receiptNumber: "PENDING-shared-provider-ref",
  };
  await Payment.create({
    _id: paymentA,
    tenantId: tenantA._id,
    branchId: branchA._id,
    schemeId: schemeA,
    customerId: customerA,
    amountPaise: 50000,
    ...paymentBase,
    receiptNumber: `PENDING-${paymentA}`,
  });
  await Payment.create({
    _id: paymentB,
    tenantId: tenantB._id,
    branchId: branchB._id,
    schemeId: schemeB,
    customerId: customerB,
    amountPaise: 75000,
    ...paymentBase,
    receiptNumber: `PENDING-${paymentB}`,
  });
  await PaymentIntent.create({
    _id: intentA,
    tenantId: tenantA._id,
    paymentId: paymentA,
    schemeId: schemeA,
    amountPaise: 50000,
    positionVersion: 1,
    status: "PENDING",
    version: 1,
  });
  await PaymentIntent.create({
    _id: intentB,
    tenantId: tenantB._id,
    paymentId: paymentB,
    schemeId: schemeB,
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
      data: {
        merchantTransactionId: sharedReference,
        transactionId: "txn-a",
        state: "FAILED",
      },
    },
  });
  await processWebhook({ data: { webhookEventId: eventId }, attemptsMade: 0 });
  const afterA = await PaymentIntent.findById(intentA).lean();
  const afterB = await PaymentIntent.findById(intentB).lean();
  assert.equal(afterA.status, "FAILED");
  assert.equal(afterB.status, "PENDING");
});
