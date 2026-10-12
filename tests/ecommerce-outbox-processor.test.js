import test from "node:test";
import assert from "node:assert/strict";
import { JobStatus, MessageType } from "../src/constants/enums.js";
import { ECOMMERCE_OUTBOX_TOPICS } from "../src/lib/ecommerce-commerce-outbox.js";
import { processEcommerceOutboxEvent } from "../src/lib/ecommerce-outbox-processor.js";
import { processOutbox } from "../src/workers/processors.js";
import {
  OutboxEvent,
  Message,
  EcommerceOrder,
  EcommercePaymentAttempt,
} from "../src/models/index.js";
import { EcommercePaymentAttemptStatus } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { EcommerceOrderStatus } from "../src/constants/enums.js";

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

test("payment succeeded outbox queues push notification once", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const orderId = createId("eord");
  const paymentAttemptId = createId("epay");
  await EcommerceOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customer._id,
    orderNumber: "EC-TEST-001",
    status: EcommerceOrderStatus.PAID,
    paidAt: new Date(),
    successfulPaymentAttemptId: paymentAttemptId,
    totalPaise: 100_000,
    version: 1,
    lines: [],
  });
  await EcommercePaymentAttempt.create({
    _id: paymentAttemptId,
    tenantId: tenant._id,
    orderId,
    customerId: customer._id,
    status: EcommercePaymentAttemptStatus.SUCCEEDED,
    amountPaise: 100_000,
    currency: "INR",
    version: 1,
  });
  const event = {
    _id: createId("outbox"),
    tenantId: tenant._id,
    topic: ECOMMERCE_OUTBOX_TOPICS.PAYMENT_SUCCEEDED,
    key: orderId,
    payload: { orderId, paymentAttemptId },
  };
  const second = await processEcommerceOutboxEvent(event);
  assert.ok(["QUEUED", "NO_DELIVERY_CHANNEL"].includes(second.outcome));
  const third = await processEcommerceOutboxEvent({ ...event, _id: createId("outbox3") });
  assert.ok(["ALREADY_NOTIFIED", "QUEUED"].includes(third.outcome));
  if (second.outcome === "QUEUED") {
    assert.equal(third.outcome, "ALREADY_NOTIFIED");
  }
  if (second.outcome === "QUEUED") {
    assert.equal(
      await Message.countDocuments({
        tenantId: tenant._id,
        type: MessageType.ECOMMERCE_ORDER_CONFIRMED,
      }),
      1,
    );
  }
});

test("processOutbox completes ecommerce topic instead of dead letter", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const orderId = createId("eord");
  await EcommerceOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customer._id,
    orderNumber: "EC-TEST-002",
    status: EcommerceOrderStatus.PAYMENT_EXPIRED,
    totalPaise: 50_000,
    version: 1,
    lines: [],
  });
  const row = await OutboxEvent.create({
    tenantId: tenant._id,
    topic: ECOMMERCE_OUTBOX_TOPICS.PAYMENT_EXPIRED,
    key: `${orderId}:expired`,
    payload: { orderId },
    status: JobStatus.QUEUED,
    availableAt: new Date(),
  });
  await processOutbox({ data: { outboxEventId: row._id }, attemptsMade: 0 });
  const after = await OutboxEvent.findById(row._id).lean();
  assert.equal(after.status, JobStatus.COMPLETED);
});

test("tenant isolation: wrong tenant order is not notified", async () => {
  const a = await seedTenantUser({});
  const b = await seedTenantUser({ tenantCode: "ISO2" });
  const customer = await seedCustomer({ tenantId: a.tenant._id, branchId: a.branch._id });
  const orderId = createId("eord");
  await EcommerceOrder.create({
    _id: orderId,
    tenantId: a.tenant._id,
    customerId: customer._id,
    orderNumber: "EC-ISO",
    status: EcommerceOrderStatus.PAYMENT_EXPIRED,
    version: 1,
    lines: [],
  });
  const result = await processEcommerceOutboxEvent({
    _id: createId("outbox"),
    tenantId: b.tenant._id,
    topic: ECOMMERCE_OUTBOX_TOPICS.PAYMENT_EXPIRED,
    key: orderId,
    payload: { orderId },
  });
  assert.equal(result.outcome, "ORDER_NOT_FOUND");
});
