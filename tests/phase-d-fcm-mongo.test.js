import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../src/config/env.js";
import { createId } from "../src/lib/ids.js";
import { fcmTokenRecordFromPlain } from "../src/lib/fcm-tokens.js";
import {
  CustomerStatus,
  DevicePrincipalType,
  DeviceRegistrationStatus,
  JobStatus,
} from "../src/constants/enums.js";
import {
  Customer,
  DeviceRegistration,
  Message,
  OutboxEvent,
  PushBroadcast,
} from "../src/models/index.js";
import {
  clearBroadcastLease,
  fetchAudienceCustomerPage,
  processPushBroadcastFanout,
} from "../src/services/push-broadcast.service.js";
import { startTestDb, stopTestDb, resetTestDb, seedTenantUser } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });

async function bulkSeedEligibleCustomers({
  tenantId,
  branchId,
  count,
  idPrefix,
  devicePrefix,
}) {
  const batchSize = 500;
  for (let offset = 0; offset < count; offset += batchSize) {
    const customers = [];
    const devices = [];
    const limit = Math.min(batchSize, count - offset);
    for (let i = 0; i < limit; i += 1) {
      const n = offset + i;
      const customerId = createId("customer");
      customers.push({
        _id: customerId,
        tenantId,
        branchId,
        customerNumber: `${idPrefix}${n}`,
        name: `Load ${n}`,
        mobile: `+9196${String(n).padStart(8, "0")}`,
        status: CustomerStatus.ACTIVE,
      });
      const token = fcmTokenRecordFromPlain({
        fcmToken: `token-${idPrefix}-${n}`,
        deviceId: `${devicePrefix}${n}`,
        platform: "android",
      });
      devices.push({
        _id: createId("dvr"),
        tenantId,
        principalType: DevicePrincipalType.CUSTOMER,
        principalId: customerId,
        deviceId: `${devicePrefix}${n}`,
        platform: "android",
        tokenHash: token.tokenHash,
        tokenSealed: token.tokenSealed,
        status: DeviceRegistrationStatus.ACTIVE,
        version: 1,
      });
    }
    await Customer.insertMany(customers, { ordered: false });
    await DeviceRegistration.insertMany(devices, { ordered: false });
  }
}

test("fetchAudienceCustomerPage returns 15000 unique tenant-scoped recipients", {
  skip: process.env.RUN_HEAVY === "1" ? false : "heavy 15k scan — set RUN_HEAVY=1 to run",
}, async () => {
  await resetTestDb();
  const { tenant: target, branch } = await seedTenantUser({ tenantCode: "LOADA" });
  const { tenant: other, branch: otherBranch } = await seedTenantUser({ tenantCode: "LOADB" });
  await bulkSeedEligibleCustomers({
    tenantId: target._id,
    branchId: branch._id,
    count: 15_000,
    idPrefix: "A",
    devicePrefix: "staging-fcm-a-",
  });
  await bulkSeedEligibleCustomers({
    tenantId: other._id,
    branchId: otherBranch._id,
    count: 50,
    idPrefix: "B",
    devicePrefix: "staging-fcm-b-",
  });

  const pageLimit = env.PUSH_BROADCAST_CHUNK_SIZE ?? 400;
  let cursor = null;
  const seen = new Set();
  let maxPage = 0;
  let pages = 0;
  while (true) {
    const page = await fetchAudienceCustomerPage({
      tenantId: target._id,
      broadcast: { audience: "ALL_DEVICES" },
      cursorCustomerId: cursor,
      limit: pageLimit,
    });
    if (!page.length) break;
    pages += 1;
    maxPage = Math.max(maxPage, page.length);
    for (const row of page) {
      assert.ok(!seen.has(row._id));
      seen.add(row._id);
    }
    cursor = page[page.length - 1]._id;
    if (page.length < pageLimit) break;
  }
  assert.equal(seen.size, 15_000);
  assert.ok(maxPage <= pageLimit);
  assert.equal(pages, Math.ceil(15_000 / pageLimit));
});

test("broadcast fan-out resumes without duplicate messages", async () => {
  await resetTestDb();
  const { tenant, branch, user } = await seedTenantUser();
  const total = 1200;
  await bulkSeedEligibleCustomers({
    tenantId: tenant._id,
    branchId: branch._id,
    count: total,
    idPrefix: "F",
    devicePrefix: "staging-fcm-f-",
  });
  const broadcast = await PushBroadcast.create({
    _id: createId("pbc"),
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "Resume test",
    body: "Body",
    audience: "ALL_DEVICES",
    status: JobStatus.QUEUED,
    stats: { audienceCount: total, messagesQueued: 0, delivered: 0, failed: 0 },
  });

  const pageLimit = env.PUSH_BROADCAST_CHUNK_SIZE ?? 400;
  await Promise.all([
    processPushBroadcastFanout(broadcast._id, "worker_a"),
    processPushBroadcastFanout(broadcast._id, "worker_b"),
  ]);
  const messagesAfterParallel = await Message.countDocuments({
    tenantId: tenant._id,
    "templateParams.broadcastId": broadcast._id,
  });
  assert.equal(messagesAfterParallel, pageLimit);

  let guard = 0;
  while (guard < 20) {
    const row = await PushBroadcast.findById(broadcast._id).lean();
    if (row.status === JobStatus.COMPLETED) break;
    await processPushBroadcastFanout(broadcast._id, `worker_run_${guard}`);
    guard += 1;
  }
  const finalRow = await PushBroadcast.findById(broadcast._id).lean();
  assert.equal(finalRow.status, JobStatus.COMPLETED);
  assert.equal(
    await Message.countDocuments({
      tenantId: tenant._id,
      "templateParams.broadcastId": broadcast._id,
    }),
    total,
  );
  assert.equal(
    await OutboxEvent.countDocuments({
      tenantId: tenant._id,
      topic: "message.send",
    }),
    0,
  );
});

test("page two fan-out starts immediately after page one releases lease", async () => {
  await resetTestDb();
  const { tenant, branch, user } = await seedTenantUser();
  const chunk = env.PUSH_BROADCAST_CHUNK_SIZE ?? 400;
  await bulkSeedEligibleCustomers({
    tenantId: tenant._id,
    branchId: branch._id,
    count: chunk + 50,
    idPrefix: "P",
    devicePrefix: "staging-fcm-p-",
  });
  const broadcast = await PushBroadcast.create({
    _id: createId("pbc"),
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "Immediate page 2",
    body: "Body",
    audience: "ALL_DEVICES",
    status: JobStatus.QUEUED,
    stats: { audienceCount: chunk + 50, messagesQueued: 0, delivered: 0, failed: 0 },
  });
  const t0 = Date.now();
  await processPushBroadcastFanout(broadcast._id, "worker_page_1");
  const afterPage1 = await PushBroadcast.findById(broadcast._id).lean();
  assert.ok(!afterPage1.leaseOwner);
  await processPushBroadcastFanout(broadcast._id, "worker_page_2");
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `expected immediate page 2, took ${elapsed}ms`);
  assert.ok(
    (await Message.countDocuments({
      tenantId: tenant._id,
      "templateParams.broadcastId": broadcast._id,
    })) > chunk,
  );
});

test("stale lease token cannot clear a newer broadcast lease", async () => {
  await resetTestDb();
  const { tenant, user } = await seedTenantUser();
  const broadcast = await PushBroadcast.create({
    _id: createId("pbc"),
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "Lease fence",
    body: "Body",
    audience: "ALL_DEVICES",
    status: JobStatus.PROCESSING,
    leaseOwner: "pbclease_new_token",
    leaseExpiresAt: new Date(Date.now() + 120_000),
    stats: { audienceCount: 1, messagesQueued: 0, delivered: 0, failed: 0 },
  });
  const stale = await clearBroadcastLease({
    broadcastId: broadcast._id,
    tenantId: tenant._id,
    leaseToken: "pbclease_stale_token",
  });
  assert.equal(stale.modifiedCount, 0);
  const row = await PushBroadcast.findById(broadcast._id).lean();
  assert.equal(row.leaseOwner, "pbclease_new_token");
});

test("stale broadcast lease owner cannot advance cursor", async () => {
  await resetTestDb();
  const { tenant, branch, user } = await seedTenantUser();
  await bulkSeedEligibleCustomers({
    tenantId: tenant._id,
    branchId: branch._id,
    count: 500,
    idPrefix: "S",
    devicePrefix: "staging-fcm-s-",
  });
  const broadcast = await PushBroadcast.create({
    _id: createId("pbc"),
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "Lease",
    body: "Body",
    audience: "ALL_DEVICES",
    status: JobStatus.QUEUED,
    stats: { audienceCount: 500, messagesQueued: 0, delivered: 0, failed: 0 },
  });
  await processPushBroadcastFanout(broadcast._id, "owner_a");
  const afterA = await PushBroadcast.findById(broadcast._id).lean();
  const cursorAfterA = afterA.cursorCustomerId;
  await PushBroadcast.updateOne(
    { _id: broadcast._id },
    { $set: { leaseOwner: "owner_b", leaseExpiresAt: new Date(Date.now() + 120_000) } },
  );
  await processPushBroadcastFanout(broadcast._id, "owner_a");
  const afterStale = await PushBroadcast.findById(broadcast._id).lean();
  assert.equal(afterStale.cursorCustomerId, cursorAfterA);
});
