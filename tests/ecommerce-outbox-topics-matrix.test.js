import test from "node:test";
import assert from "node:assert/strict";
import {
  JobStatus,
  MessageType,
  EcommerceOrderStatus,
  EcommercePaymentAttemptStatus,
  EcommercePaymentExceptionRefundStatus,
  EcommerceOrderRefundSource,
} from "../src/constants/enums.js";
import { ECOMMERCE_OUTBOX_TOPICS } from "../src/lib/ecommerce-commerce-outbox.js";
import { processEcommerceOutboxEvent } from "../src/lib/ecommerce-outbox-processor.js";
import { processOutbox } from "../src/workers/processors.js";
import {
  OutboxEvent,
  Message,
  EcommerceOrder,
  EcommercePaymentAttempt,
  EcommercePaymentExceptionRefund,
  Customer,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function seedPaidOrder({ tenant, customer, orderId = createId("eord") }) {
  const paymentAttemptId = createId("epay");
  await EcommerceOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customer._id,
    orderNumber: `EC-${orderId.slice(-6)}`,
    status: EcommerceOrderStatus.PAID,
    paidAt: new Date(),
    successfulPaymentAttemptId: paymentAttemptId,
    totalPaise: 80_000,
    version: 1,
    lines: [],
  });
  await EcommercePaymentAttempt.create({
    _id: paymentAttemptId,
    tenantId: tenant._id,
    orderId,
    customerId: customer._id,
    status: EcommercePaymentAttemptStatus.SUCCEEDED,
    amountPaise: 80_000,
    currency: "INR",
    version: 1,
  });
  return { orderId, paymentAttemptId };
}

for (const [label, topic, setup, expectOutcome] of [
  [
    "payment failed",
    ECOMMERCE_OUTBOX_TOPICS.PAYMENT_FAILED,
    async ({ tenant, branch: _branch, customer }) => {
      const orderId = createId("eord");
      const paymentAttemptId = createId("epay");
      await EcommerceOrder.create({
        _id: orderId,
        tenantId: tenant._id,
        customerId: customer._id,
        orderNumber: "EC-FAIL",
        status: EcommerceOrderStatus.PENDING_PAYMENT,
        totalPaise: 10_000,
        version: 1,
        lines: [],
      });
      return { orderId, paymentAttemptId, payload: { orderId, paymentAttemptId } };
    },
    ["QUEUED", "NO_DELIVERY_CHANNEL"],
  ],
  [
    "fulfilment shipped",
    ECOMMERCE_OUTBOX_TOPICS.FULFILMENT_MILESTONE,
    async ({ tenant, branch: _branch, customer }) => {
      const { orderId } = await seedPaidOrder({ tenant, customer });
      await EcommerceOrder.updateOne(
        { _id: orderId },
        {
          $set: {
            status: EcommerceOrderStatus.SHIPPED,
            deliveryTracking: { carrierName: "X", trackingNumber: "1" },
          },
        },
      );
      return { orderId, payload: { orderId, status: EcommerceOrderStatus.SHIPPED } };
    },
    ["QUEUED", "NO_DELIVERY_CHANNEL"],
  ],
  [
    "cod accepted",
    ECOMMERCE_OUTBOX_TOPICS.ORDER_UPDATED,
    async ({ tenant, branch: _branch, customer }) => {
      const orderId = createId("eord");
      await EcommerceOrder.create({
        _id: orderId,
        tenantId: tenant._id,
        customerId: customer._id,
        orderNumber: "EC-COD",
        status: EcommerceOrderStatus.PROCESSING,
        paymentMethod: "COD",
        totalPaise: 10_000,
        version: 1,
        lines: [],
      });
      return { orderId, payload: { orderId, kind: "COD_ACCEPTED" } };
    },
    ["QUEUED", "NO_DELIVERY_CHANNEL"],
  ],
  [
    "payment expired",
    ECOMMERCE_OUTBOX_TOPICS.PAYMENT_EXPIRED,
    async ({ tenant, branch: _branch, customer }) => {
      const orderId = createId("eord");
      await EcommerceOrder.create({
        _id: orderId,
        tenantId: tenant._id,
        customerId: customer._id,
        orderNumber: "EC-EXP",
        status: EcommerceOrderStatus.PAYMENT_EXPIRED,
        totalPaise: 10_000,
        version: 1,
        lines: [],
      });
      return { orderId, payload: { orderId } };
    },
    ["QUEUED", "NO_DELIVERY_CHANNEL"],
  ],
  [
    "refund completed",
    ECOMMERCE_OUTBOX_TOPICS.REFUND_COMPLETED,
    async ({ tenant, branch: _branch, customer }) => {
      const { orderId } = await seedPaidOrder({ tenant, customer });
      const refundId = createId("epayref");
      await EcommercePaymentExceptionRefund.create({
        _id: refundId,
        tenantId: tenant._id,
        orderId,
        paymentAttemptId: (await EcommercePaymentAttempt.findOne({ orderId }).lean())._id,
        amountPaise: 80_000,
        currency: "INR",
        status: EcommercePaymentExceptionRefundStatus.SUCCEEDED,
        refundSource: EcommerceOrderRefundSource.ORDER_RETURN,
        version: 1,
      });
      return { orderId, payload: { orderId, refundId } };
    },
    ["QUEUED", "NO_DELIVERY_CHANNEL"],
  ],
]) {
  test(`worker notifies: ${label}`, async () => {
    const { tenant, branch } = await seedTenantUser({});
    const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
    const ctx = await setup({ tenant, branch, customer });
    const row = await OutboxEvent.create({
      tenantId: tenant._id,
      topic,
      key: `${ctx.orderId}:${label}`,
      payload: ctx.payload,
      status: JobStatus.QUEUED,
      availableAt: new Date(),
    });
    await processOutbox({ data: { outboxEventId: row._id }, attemptsMade: 0 });
    const after = await OutboxEvent.findById(row._id).lean();
    assert.equal(after.status, JobStatus.COMPLETED);
    const direct = await processEcommerceOutboxEvent({
      _id: createId("outbox-dup"),
      tenantId: tenant._id,
      topic,
      key: row.key,
      payload: ctx.payload,
    });
    assert.ok(expectOutcome.includes(direct.outcome) || direct.outcome === "ALREADY_NOTIFIED");
  });
}

test("whatsapp opt-out still allows in-app message row when push queues", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await Customer.updateOne({ _id: customer._id }, { $set: { whatsappOptedOutAt: new Date() } });
  const { orderId, paymentAttemptId } = await seedPaidOrder({ tenant, branch, customer });
  const result = await processEcommerceOutboxEvent({
    _id: createId("outbox"),
    tenantId: tenant._id,
    topic: ECOMMERCE_OUTBOX_TOPICS.PAYMENT_SUCCEEDED,
    key: orderId,
    payload: { orderId, paymentAttemptId },
  });
  assert.ok(["QUEUED", "NO_DELIVERY_CHANNEL"].includes(result.outcome));
  if (result.outcome === "QUEUED") {
    assert.ok(await Message.exists({ tenantId: tenant._id, type: MessageType.ECOMMERCE_ORDER_CONFIRMED }));
  }
});

test("duplicate outbox event id does not duplicate payment succeeded notification", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, paymentAttemptId } = await seedPaidOrder({ tenant, branch, customer });
  const event = {
    _id: createId("outbox"),
    tenantId: tenant._id,
    topic: ECOMMERCE_OUTBOX_TOPICS.PAYMENT_SUCCEEDED,
    key: orderId,
    payload: { orderId, paymentAttemptId },
  };
  const first = await processEcommerceOutboxEvent(event);
  const second = await processEcommerceOutboxEvent({ ...event, _id: createId("outbox2") });
  if (first.outcome === "QUEUED") {
    assert.equal(second.outcome, "ALREADY_NOTIFIED");
    assert.equal(
      await Message.countDocuments({
        tenantId: tenant._id,
        "templateParams.inboxEventKey": `ecommerce.payment.succeeded:${orderId}:${paymentAttemptId}`,
      }),
      1,
    );
  }
});
