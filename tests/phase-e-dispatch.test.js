import test from "node:test";
import assert from "node:assert/strict";
import IORedis from "ioredis";
import { env } from "../src/config/env.js";
import { connectRedis, redisReady } from "../src/config/redis.js";
import { closeQueues, getQueue } from "../src/queues/index.js";
import {
  DispatchState,
  MessageChannel,
  MessageStatus,
  MessageType,
} from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import {
  acknowledgeDispatch,
  claimDispatchLease,
  dispatchClaimEligibleFilter,
  messageDispatchStatusFilter,
  reclaimExpiredDispatchLeases,
} from "../src/lib/dispatch-lease.js";
import {
  dispatchTestHooks,
  resetDispatchTestHooksForTests,
} from "../src/lib/dispatch-test-hooks.js";
import { fetchFairDispatchCandidates } from "../src/lib/fair-message-dispatch.js";
import { Message } from "../src/models/index.js";
import { runDispatchCycle } from "../src/services/dispatch.service.js";
import { runDispatchLeaseReclamation } from "../src/services/dispatch-reclaim.service.js";
import { buildBroadcastChunkWrites } from "../src/services/push-broadcast.service.js";
import { resetOpsMetricsForTests } from "../src/lib/ops-metrics.js";
import { startTestDb, stopTestDb, resetTestDb } from "./helpers/db.js";

async function assertRedisGate() {
  const probe = new IORedis(env.REDIS_URL, {
    connectTimeout: 1500,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  try {
    await probe.connect();
    await probe.ping();
    await probe.quit();
  } catch (error) {
    assert.fail(`Redis required for Phase E tests: ${error.message}`);
  }
  const connected = await connectRedis().catch(() => false);
  assert.ok(connected && redisReady(), "Redis connection failed");
}

async function flushMessageQueueJobs() {
  const queue = getQueue("messages");
  if (!queue) return;
  await queue.obliterate({ force: true }).catch(() => {});
}

async function seedMessage({ tenantId, customerId = createId("customer") }) {
  return Message.create({
    _id: createId("message"),
    tenantId,
    customerId,
    type: MessageType.MANUAL_PUSH,
    status: MessageStatus.QUEUED,
    channel: MessageChannel.PUSH,
    templateKey: MessageType.MANUAL_PUSH,
    templateParams: { title: "t", body: "b" },
    dispatchPriority: 0,
  });
}

test.before(async () => {
  await assertRedisGate();
  await startTestDb();
});
test.after(async () => {
  resetDispatchTestHooksForTests();
  await flushMessageQueueJobs();
  await closeQueues();
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
  resetDispatchTestHooksForTests();
  resetOpsMetricsForTests();
  await flushMessageQueueJobs();
});

test("concurrent dispatch claims allow only one lease owner", async () => {
  const tenantId = createId("tenant");
  const msg = await seedMessage({ tenantId });
  const [a, b] = await Promise.all([
    claimDispatchLease(Message, messageDispatchStatusFilter, msg._id, "owner_a"),
    claimDispatchLease(Message, messageDispatchStatusFilter, msg._id, "owner_b"),
  ]);
  const winners = [a, b].filter(Boolean);
  assert.equal(winners.length, 1);
  assert.ok(["owner_a", "owner_b"].includes(winners[0].dispatchLeaseOwner));
});

test("expired dispatch lease is reclaimable and redispatchable", async () => {
  const tenantId = createId("tenant");
  const msg = await seedMessage({ tenantId });
  const past = new Date(Date.now() - 60_000);
  await Message.updateOne(
    { _id: msg._id },
    {
      $set: {
        dispatchState: DispatchState.DISPATCHING,
        dispatchLeaseOwner: "stale_owner",
        dispatchLeaseExpiresAt: past,
      },
    },
  );
  const reclaimed = await reclaimExpiredDispatchLeases(Message, messageDispatchStatusFilter, 50);
  assert.equal(reclaimed, 1);
  const row = await Message.findById(msg._id).lean();
  assert.equal(row.dispatchState, DispatchState.PENDING);
  const claimed = await claimDispatchLease(Message, messageDispatchStatusFilter, msg._id, "recovery");
  assert.ok(claimed);
});

test("active dispatch lease cannot be stolen by another owner", async () => {
  const tenantId = createId("tenant");
  const msg = await seedMessage({ tenantId });
  const future = new Date(Date.now() + 120_000);
  await Message.updateOne(
    { _id: msg._id },
    {
      $set: {
        dispatchState: DispatchState.DISPATCHING,
        dispatchLeaseOwner: "active_owner",
        dispatchLeaseExpiresAt: future,
      },
    },
  );
  const stolen = await claimDispatchLease(Message, messageDispatchStatusFilter, msg._id, "intruder");
  assert.equal(stolen, null);
});

test("fair dispatch selects small tenants outside a large backlog window", async () => {
  const bigTenant = createId("tenant_big");
  const smallTenants = [createId("tenant_s1"), createId("tenant_s2"), createId("tenant_s3")];
  const bulk = [];
  for (let i = 0; i < 80; i += 1) {
    bulk.push({
      _id: createId("message"),
      tenantId: bigTenant,
      customerId: createId("customer"),
      type: MessageType.MANUAL_PUSH,
      status: MessageStatus.QUEUED,
      channel: MessageChannel.PUSH,
      templateKey: MessageType.MANUAL_PUSH,
      templateParams: {},
      dispatchPriority: 0,
      createdAt: new Date(Date.now() - 10_000 + i),
    });
  }
  for (const tenantId of smallTenants) {
    bulk.push({
      _id: createId("message"),
      tenantId,
      customerId: createId("customer"),
      type: MessageType.MANUAL_PUSH,
      status: MessageStatus.QUEUED,
      channel: MessageChannel.PUSH,
      templateKey: MessageType.MANUAL_PUSH,
      templateParams: {},
      dispatchPriority: 0,
      createdAt: new Date(),
    });
  }
  await Message.insertMany(bulk);
  const baseFilter = {
    ...messageDispatchStatusFilter,
    ...dispatchClaimEligibleFilter(),
  };
  const { batch } = await fetchFairDispatchCandidates(Message, baseFilter, {
    perTenant: 2,
    global: 12,
    sort: { dispatchPriority: 1, createdAt: 1 },
    select: "_id tenantId",
  });
  const tenants = new Set(batch.map((row) => row.tenantId));
  for (const small of smallTenants) {
    assert.ok(tenants.has(small), `small tenant ${small} must appear in first fair batch`);
  }
});

test("crash after claim before queue add is recovered by reclaim", async () => {
  const tenantId = createId("tenant");
  const msg = await seedMessage({ tenantId });
  dispatchTestHooks.pauseAfterClaimBeforeQueue = true;
  await runDispatchCycle();
  const mid = await Message.findById(msg._id).lean();
  assert.equal(mid.dispatchState, DispatchState.DISPATCHING);
  resetDispatchTestHooksForTests();
  await Message.updateOne(
    { _id: msg._id },
    { $set: { dispatchLeaseExpiresAt: new Date(Date.now() - 1000) } },
  );
  await reclaimExpiredDispatchLeases(Message, messageDispatchStatusFilter, 10);
  dispatchTestHooks.pauseAfterClaimBeforeQueue = false;
  await runDispatchCycle();
  const after = await Message.findById(msg._id).lean();
  assert.equal(after.dispatchState, DispatchState.DISPATCHED);
  const queue = getQueue("messages");
  const job = await queue.getJob(String(msg._id));
  assert.ok(job);
});

test("crash after queue add before ack converges with deterministic job id", async () => {
  const tenantId = createId("tenant");
  const msg = await seedMessage({ tenantId });
  dispatchTestHooks.pauseAfterQueueBeforeAck = true;
  await runDispatchCycle();
  const mid = await Message.findById(msg._id).lean();
  assert.equal(mid.dispatchState, DispatchState.DISPATCHING);
  resetDispatchTestHooksForTests();
  await Message.updateOne(
    { _id: msg._id },
    { $set: { dispatchLeaseExpiresAt: new Date(Date.now() - 1000) } },
  );
  await reclaimExpiredDispatchLeases(Message, messageDispatchStatusFilter, 10);
  await runDispatchCycle();
  const jobs = await getQueue("messages").getJobs(["waiting", "delayed", "active", "completed"]);
  const ids = jobs.filter((j) => j.data?.messageId === String(msg._id));
  assert.ok(ids.length >= 1);
  const after = await Message.findById(msg._id).lean();
  assert.equal(after.dispatchState, DispatchState.DISPATCHED);
});

test("duplicate queue add attempts use stable BullMQ job ids", async () => {
  const tenantId = createId("tenant");
  const msg = await seedMessage({ tenantId });
  const owner = "dup_test";
  await claimDispatchLease(Message, messageDispatchStatusFilter, msg._id, owner);
  const queue = getQueue("messages");
  await queue.add(msg.type, { messageId: String(msg._id) }, { jobId: String(msg._id) });
  await queue.add(msg.type, { messageId: String(msg._id) }, { jobId: String(msg._id) }).catch(() => {});
  await acknowledgeDispatch(Message, msg._id, owner);
  const count = await queue.getJobCounts("waiting", "delayed", "active");
  assert.ok(count.waiting + count.delayed + count.active <= 1);
});

test("concurrent dispatcher replicas do not double-claim the same message", async () => {
  const tenantId = createId("tenant");
  await Promise.all(Array.from({ length: 5 }, () => seedMessage({ tenantId })));
  await Promise.all([runDispatchCycle(), runDispatchCycle(), runDispatchCycle()]);
  const dispatching = await Message.countDocuments({
    tenantId,
    dispatchState: DispatchState.DISPATCHING,
  });
  assert.equal(dispatching, 0);
  const dispatched = await Message.countDocuments({
    tenantId,
    dispatchState: DispatchState.DISPATCHED,
  });
  assert.equal(dispatched, 5);
});

test("concurrent stale reclaimers use compare-and-set safely", async () => {
  const tenantId = createId("tenant");
  const msg = await seedMessage({ tenantId });
  const past = new Date(Date.now() - 1000);
  await Message.updateOne(
    { _id: msg._id },
    {
      $set: {
        dispatchState: DispatchState.DISPATCHING,
        dispatchLeaseOwner: "gone",
        dispatchLeaseExpiresAt: past,
      },
    },
  );
  const results = await Promise.all([
    reclaimExpiredDispatchLeases(Message, messageDispatchStatusFilter, 50),
    reclaimExpiredDispatchLeases(Message, messageDispatchStatusFilter, 50),
  ]);
  assert.equal(results.reduce((a, b) => a + b, 0), 1);
});

test("broadcast chunk writes do not create message.send outbox rows", () => {
  const { messageOps, outboxOps } = buildBroadcastChunkWrites({
    broadcast: {
      _id: "pbc_1",
      tenantId: "tnt_1",
      title: "Hi",
      body: "There",
      deepLink: "/home",
    },
    customers: [{ _id: "cus_1", branchId: "brn_1" }],
  });
  assert.equal(messageOps.length, 1);
  assert.equal(outboxOps.length, 0);
});

test("release dispatch lease returns row to pending after queue failure", async () => {
  const tenantId = createId("tenant");
  const msg = await seedMessage({ tenantId });
  dispatchTestHooks.throwOnQueueAdd = true;
  await assert.rejects(async () => runDispatchCycle());
  resetDispatchTestHooksForTests();
  const row = await Message.findById(msg._id).lean();
  assert.equal(row.dispatchState, DispatchState.PENDING);
});

test("dispatch reclaim maintenance runs bounded batches", async () => {
  const tenantId = createId("tenant");
  const msg = await seedMessage({ tenantId });
  await Message.updateOne(
    { _id: msg._id },
    {
      $set: {
        dispatchState: DispatchState.DISPATCHED,
        dispatchedAt: new Date(Date.now() - env.MESSAGE_DISPATCH_DISPATCHED_STALE_MS - 1000),
      },
    },
  );
  const summary = await runDispatchLeaseReclamation();
  assert.ok(summary.messages >= 1);
  const row = await Message.findById(msg._id).lean();
  assert.equal(row.dispatchState, DispatchState.PENDING);
});
