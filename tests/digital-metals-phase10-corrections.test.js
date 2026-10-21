import { randomUUID } from "node:crypto";
process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
import test from "node:test";
import assert from "node:assert/strict";
import { MessageType } from "../src/constants/enums.js";
import { DIGITAL_METAL_OUTBOX_TOPICS } from "../src/lib/digital-metals-outbox.js";
import { digitalMetalInboxEventKey } from "../src/lib/digital-metals-customer-notice.js";
import {
  deepLinkBuyOrder,
  deepLinkDocumentArtifact,
  deepLinkSellOrder,
} from "../src/lib/digital-metals-customer-deep-links.js";
import { classifyDigitalMetalOutboxDispatchOutcome } from "../src/lib/digital-metals-outbox-dispatch-outcomes.js";
import { queueDigitalMetalInboxPushMessage } from "../src/lib/digital-metals-inbox-queue.js";
import { processDigitalMetalCustomerNoticeOutboxEvent } from "../src/lib/digital-metals-notification-processor.js";
import { DigitalMetalOutboxEvent, Message, Tenant } from "../src/models/index.js";
import { runDigitalMetalOutboxDispatch } from "../src/services/digital-metals-outbox-dispatch.service.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { createId } from "../src/lib/ids.js";
import { PlanTier } from "../src/constants/enums.js";

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

test("QUEUE_FAILED is retryable and leaves outbox not PROCESSED", () => {
  const c = classifyDigitalMetalOutboxDispatchOutcome({ outcome: "QUEUE_FAILED" });
  assert.equal(c.disposition, "RETRYABLE");
  assert.equal(c.retryable, true);
});

test("deep link paths align with customer router segments", () => {
  assert.equal(deepLinkBuyOrder("TEST_CO", "dmbo_x"), "/customer/test-co/digital-metals/order/dmbo_x");
  assert.equal(deepLinkSellOrder("TEST_CO", "dmso_x"), "/customer/test-co/digital-metals/sell-order/dmso_x");
  assert.equal(deepLinkDocumentArtifact("TEST_CO", "dmdoc_x"), "/customer/test-co/digital-metals/document/dmdoc_x");
});

test("atomic inbox dedupe allows one message for concurrent claims (real Mongo)", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const inboxEventKey = digitalMetalInboxEventKey("purchase.credited", "dmbo_dedupe");
  const base = {
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    type: MessageType.DIGITAL_METAL_PURCHASE_CREDITED,
    inboxEventKey,
    templateParams: { title: "t", body: "b", deepLink: "/x" },
  };
  const [a, b] = await Promise.all([
    queueDigitalMetalInboxPushMessage(base),
    queueDigitalMetalInboxPushMessage(base),
  ]);
  const outcomes = new Set([a.outcome, b.outcome]);
  assert.ok(outcomes.has("QUEUED"));
  assert.ok(outcomes.has("ALREADY_NOTIFIED"));
  const count = await Message.countDocuments({ tenantId: tenant._id, "templateParams.inboxEventKey": inboxEventKey });
  assert.equal(count, 1);
});

test("temporary QUEUE_FAILED then recovery yields one inbox event (real Mongo)", async () => {
  const { tenant, branch } = await seedTenantUser({});
  await Tenant.updateOne(
    { _id: tenant._id },
    {
      $set: {
        "subscription.planFeaturesSnapshot.digitalMetals": true,
        "operations.digitalMetalsEnabled": true,
        "subscription.tier": PlanTier.GROWTH,
      },
    },
  );
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const orderId = createId("dmbo");
  const eventId = createId("dmobx");
  await DigitalMetalOutboxEvent.create({
    _id: eventId,
    tenantId: tenant._id,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_CREDITED,
    key: orderId,
    payload: { orderId, customerId: customer._id },
    status: "PENDING",
  });

  const { DigitalMetalBuyOrder } = await import("../src/models/index.js");
  const originalCreate = Message.create.bind(Message);
  let failCreates = 1;
  Message.create = async (...args) => {
    if (failCreates > 0) {
      failCreates -= 1;
      throw new Error("SIMULATED_ENQUEUE_FAILURE");
    }
    return originalCreate(...args);
  };
  try {
    await DigitalMetalBuyOrder.create({
      _id: orderId,
      tenantId: tenant._id,
      customerId: customer._id,
      status: "CREDITED",
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: 1_000_000,
      creditedAt: new Date(),
      quoteId: createId("dmq"),
      quoteExpiresAt: new Date(Date.now() + 86_400_000),
      paymentAcceptanceExpiresAt: new Date(Date.now() + 86_400_000),
      termsAcceptedAt: new Date(),
      totalPayablePaise: 600_000,
      idempotencyKey: randomUUID(),
    });

    await runDigitalMetalOutboxDispatch();
    let row = await DigitalMetalOutboxEvent.findById(eventId).lean();
    assert.notEqual(row.status, "PROCESSED");
    assert.ok((row.dispatchAttempts ?? 0) >= 1);

    await DigitalMetalOutboxEvent.updateOne({ _id: eventId }, { $set: { availableAt: new Date(0) } });
    await runDigitalMetalOutboxDispatch(new Date(Date.now() + 120_000));
    row = await DigitalMetalOutboxEvent.findById(eventId).lean();
    assert.equal(row.status, "PROCESSED");
    const inboxKey = digitalMetalInboxEventKey("purchase.credited", orderId);
    assert.equal(await Message.countDocuments({ tenantId: tenant._id, "templateParams.inboxEventKey": inboxKey }), 1);
  } finally {
    Message.create = originalCreate;
  }
});

test("DELAYED_TRANSITION is retryable not completed", async () => {
  const c = classifyDigitalMetalOutboxDispatchOutcome({ outcome: "DELAYED_TRANSITION" });
  assert.equal(c.retryable, true);
  const event = {
    _id: createId("dmobx"),
    tenantId: "tnt_x",
    topic: DIGITAL_METAL_OUTBOX_TOPICS.REDEMPTION_CUSTOMER_NOTICE,
    payload: { orderId: "dmro_x", transition: "DISPATCHED" },
  };
  const r = await processDigitalMetalCustomerNoticeOutboxEvent(event);
  assert.equal(r.outcome, "ORDER_NOT_FOUND");
});
