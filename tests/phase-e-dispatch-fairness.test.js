import test from "node:test";
import assert from "node:assert/strict";
import IORedis from "ioredis";
import { env } from "../src/config/env.js";
import { connectRedis, getRedis, redisReady } from "../src/config/redis.js";
import { closeQueues } from "../src/queues/index.js";
import { MessageStatus, MessageType, MessageChannel } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { dispatchClaimEligibleFilter, messageDispatchStatusFilter } from "../src/lib/dispatch-lease.js";
import { dispatchRotationKey, fetchFairDispatchCandidates } from "../src/lib/fair-message-dispatch.js";
import { Message } from "../src/models/index.js";
import { startTestDb, stopTestDb, resetTestDb } from "./helpers/db.js";

test.before(async () => {
  const probe = new IORedis(env.REDIS_URL, { connectTimeout: 1500, maxRetriesPerRequest: 1, lazyConnect: true });
  await probe.connect();
  await probe.quit();
  await connectRedis();
  await startTestDb();
});
test.after(async () => {
  await closeQueues();
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
  if (redisReady()) {
    const key = dispatchRotationKey(Message);
    await getRedis().del(key);
  }
});

test("tenant fairness uses bounded tenant pages and rotation cursor", async () => {
  const tenants = Array.from({ length: 40 }, () => createId("tenant"));
  const bulk = [];
  for (const tenantId of tenants) {
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
    });
  }
  await Message.insertMany(bulk);
  const baseFilter = { ...messageDispatchStatusFilter, ...dispatchClaimEligibleFilter() };
  const pageSize = env.MESSAGE_DISPATCH_TENANT_PAGE_SIZE ?? 32;
  const first = await fetchFairDispatchCandidates(Message, baseFilter, {
    perTenant: 1,
    global: pageSize,
    sort: { dispatchPriority: 1, createdAt: 1 },
    select: "_id tenantId",
  });
  assert.ok(first.tenantIds.length <= pageSize);
  assert.ok(first.batch.length <= pageSize);
  const second = await fetchFairDispatchCandidates(Message, baseFilter, {
    perTenant: 1,
    global: pageSize,
    sort: { dispatchPriority: 1, createdAt: 1 },
    select: "_id tenantId",
  });
  assert.ok(second.tenantIds.length <= pageSize);
  const overlap = first.tenantIds.filter((id) => second.tenantIds.includes(id));
  assert.equal(overlap.length, 0, "rotation should advance to a new tenant page");
});

test("small tenants appear in rotated pages when large tenant dominates backlog", async () => {
  const big = createId("tenant_big");
  const small = Array.from({ length: 8 }, () => createId("tenant_small"));
  const docs = [];
  for (let i = 0; i < 200; i += 1) {
    docs.push({
      _id: createId("message"),
      tenantId: big,
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
  for (const tenantId of small) {
    docs.push({
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
  await Message.insertMany(docs);
  const baseFilter = { ...messageDispatchStatusFilter, ...dispatchClaimEligibleFilter() };
  const seenSmall = new Set();
  for (let round = 0; round < 6; round += 1) {
    const { batch, tenantIds } = await fetchFairDispatchCandidates(Message, baseFilter, {
      perTenant: 1,
      global: 16,
      sort: { dispatchPriority: 1, createdAt: 1 },
      select: "_id tenantId",
    });
    for (const row of batch) {
      if (small.includes(row.tenantId)) seenSmall.add(row.tenantId);
    }
    if (seenSmall.size === small.length) break;
    if (!tenantIds.length) break;
  }
  assert.equal(seenSmall.size, small.length);
});

test("per-tenant dispatch queries respect MESSAGE_DISPATCH_TENANT_QUERY_CONCURRENCY", async () => {
  const tenants = Array.from({ length: 16 }, () => createId("tenant"));
  await Message.insertMany(
    tenants.map((tenantId) => ({
      _id: createId("message"),
      tenantId,
      customerId: createId("customer"),
      type: MessageType.MANUAL_PUSH,
      status: MessageStatus.QUEUED,
      channel: MessageChannel.PUSH,
      templateKey: MessageType.MANUAL_PUSH,
      templateParams: {},
      dispatchPriority: 0,
    })),
  );
  const baseFilter = { ...messageDispatchStatusFilter, ...dispatchClaimEligibleFilter() };
  let inFlight = 0;
  let maxInFlight = 0;
  const origFind = Message.find.bind(Message);
  Message.find = function patchedFind(...args) {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const query = origFind(...args);
    const origLean = query.lean.bind(query);
    query.lean = function patchedLean() {
      const promise = origLean();
      return promise.finally(() => {
        inFlight -= 1;
      });
    };
    return query;
  };
  try {
    await fetchFairDispatchCandidates(Message, baseFilter, {
      perTenant: 1,
      global: 16,
      sort: { dispatchPriority: 1, createdAt: 1 },
      select: "_id tenantId",
    });
  } finally {
    Message.find = origFind;
  }
  const cap = env.MESSAGE_DISPATCH_TENANT_QUERY_CONCURRENCY ?? 4;
  assert.ok(maxInFlight <= cap, `max parallel tenant queries ${maxInFlight} > cap ${cap}`);
});
