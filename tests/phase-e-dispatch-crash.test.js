import test from "node:test";
import assert from "node:assert/strict";
import IORedis from "ioredis";
import { env } from "../src/config/env.js";
import { connectRedis } from "../src/config/redis.js";
import { closeQueues, getQueue } from "../src/queues/index.js";
import {
  DispatchState,
  JobStatus,
  MessageChannel,
  MessageStatus,
  MessageType,
  WebhookProvider,
} from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import {
  messageDispatchStatusFilter,
  reclaimExpiredDispatchLeases,
} from "../src/lib/dispatch-lease.js";
import {
  dispatchTestHooks,
  resetDispatchTestHooksForTests,
} from "../src/lib/dispatch-test-hooks.js";
import { Message, OutboxEvent, WebhookEvent } from "../src/models/index.js";
import { runDispatchCycle } from "../src/services/dispatch.service.js";
import { startTestDb, stopTestDb, resetTestDb } from "./helpers/db.js";

test.before(async () => {
  const probe = new IORedis(env.REDIS_URL, { connectTimeout: 1500, maxRetriesPerRequest: 1, lazyConnect: true });
  await probe.connect();
  await probe.quit();
  await connectRedis();
  await startTestDb();
});
test.after(async () => {
  resetDispatchTestHooksForTests();
  await getQueue("messages")?.obliterate({ force: true }).catch(() => {});
  await getQueue("outbox")?.obliterate({ force: true }).catch(() => {});
  await getQueue("webhooks")?.obliterate({ force: true }).catch(() => {});
  await closeQueues();
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
  resetDispatchTestHooksForTests();
  await getQueue("messages")?.obliterate({ force: true }).catch(() => {});
  await getQueue("outbox")?.obliterate({ force: true }).catch(() => {});
  await getQueue("webhooks")?.obliterate({ force: true }).catch(() => {});
});

async function seedMessage(tenantId = createId("tenant")) {
  return Message.create({
    _id: createId("message"),
    tenantId,
    customerId: createId("customer"),
    type: MessageType.MANUAL_PUSH,
    status: MessageStatus.QUEUED,
    channel: MessageChannel.PUSH,
    templateKey: MessageType.MANUAL_PUSH,
    templateParams: {},
  });
}

async function seedOutbox(tenantId = createId("tenant")) {
  return OutboxEvent.create({
    tenantId,
    topic: "payment.gateway.failed",
    key: `pay:${createId("payment")}`,
    payload: { paymentId: createId("payment") },
    status: JobStatus.QUEUED,
    availableAt: new Date(),
  });
}

async function seedWebhook(tenantId = createId("tenant")) {
  return WebhookEvent.create({
    _id: createId("webhook"),
    tenantId,
    provider: WebhookProvider.PHONEPE,
    providerEventId: `evt_${createId("webhook")}`,
    payload: { type: "TEST" },
    status: JobStatus.QUEUED,
  });
}

function outboxDispatchFilter() {
  return {
    status: JobStatus.QUEUED,
    availableAt: { $lte: new Date() },
    topic: { $ne: "message.send" },
  };
}

const crashCases = [
  { label: "Message", seed: seedMessage, model: Message, queue: "messages", extraFilter: () => messageDispatchStatusFilter },
  {
    label: "OutboxEvent",
    seed: seedOutbox,
    model: OutboxEvent,
    queue: "outbox",
    extraFilter: outboxDispatchFilter,
  },
  {
    label: "WebhookEvent",
    seed: seedWebhook,
    model: WebhookEvent,
    queue: "webhooks",
    extraFilter: () => ({ status: JobStatus.QUEUED }),
  },
];

for (const entity of crashCases) {
  test(`${entity.label}: crash before queue add is recoverable`, async () => {
    const row = await entity.seed();
    dispatchTestHooks.pauseAfterClaimBeforeQueue = true;
    await runDispatchCycle();
    resetDispatchTestHooksForTests();
    const mid = await entity.model.findById(row._id).lean();
    assert.equal(mid.dispatchState, DispatchState.DISPATCHING);
    await entity.model.updateOne(
      { _id: row._id },
      { $set: { dispatchLeaseExpiresAt: new Date(Date.now() - 1000) } },
    );
    await reclaimExpiredDispatchLeases(entity.model, entity.extraFilter(), 20);
    dispatchTestHooks.pauseAfterClaimBeforeQueue = false;
    await runDispatchCycle();
    const after = await entity.model.findById(row._id).lean();
    assert.equal(after.dispatchState, DispatchState.DISPATCHED);
  });

  test(`${entity.label}: crash after queue add before ack converges`, async () => {
    const row = await entity.seed();
    dispatchTestHooks.pauseAfterQueueBeforeAck = true;
    await runDispatchCycle();
    resetDispatchTestHooksForTests();
    await entity.model.updateOne(
      { _id: row._id },
      { $set: { dispatchLeaseExpiresAt: new Date(Date.now() - 1000) } },
    );
    await reclaimExpiredDispatchLeases(entity.model, entity.extraFilter(), 20);
    await runDispatchCycle();
    const job = await getQueue(entity.queue).getJob(String(row._id));
    assert.ok(job);
    const after = await entity.model.findById(row._id).lean();
    assert.equal(after.dispatchState, DispatchState.DISPATCHED);
  });

  test(`${entity.label}: stale dispatched state is reclaimed before worker`, async () => {
    const row = await entity.seed();
    await entity.model.updateOne(
      { _id: row._id },
      {
        $set: {
          dispatchState: DispatchState.DISPATCHED,
          dispatchedAt: new Date(Date.now() - env.MESSAGE_DISPATCH_DISPATCHED_STALE_MS - 1000),
        },
      },
    );
    const reclaimed = await reclaimExpiredDispatchLeases(entity.model, entity.extraFilter(), 10);
    assert.equal(reclaimed, 1);
    await runDispatchCycle();
    const after = await entity.model.findById(row._id).lean();
    assert.equal(after.dispatchState, DispatchState.DISPATCHED);
  });

  test(`${entity.label}: concurrent reclaimers are safe`, async () => {
    const row = await entity.seed();
    await entity.model.updateOne(
      { _id: row._id },
      {
        $set: {
          dispatchState: DispatchState.DISPATCHING,
          dispatchLeaseOwner: "gone",
          dispatchLeaseExpiresAt: new Date(Date.now() - 1000),
        },
      },
    );
    const results = await Promise.all([
      reclaimExpiredDispatchLeases(entity.model, entity.extraFilter(), 20),
      reclaimExpiredDispatchLeases(entity.model, entity.extraFilter(), 20),
    ]);
    assert.equal(results.reduce((a, b) => a + b, 0), 1);
  });
}

test("queue add failure releases message dispatch lease", async () => {
  const msg = await seedMessage();
  dispatchTestHooks.throwOnQueueAdd = true;
  await assert.rejects(async () => runDispatchCycle());
  resetDispatchTestHooksForTests();
  const row = await Message.findById(msg._id).lean();
  assert.equal(row.dispatchState, DispatchState.PENDING);
});
