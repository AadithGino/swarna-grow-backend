import test from "node:test";
import assert from "node:assert/strict";
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
import { processMaintenance } from "../src/workers/processors.js";
import {
  clearBroadcastLease,
  processPushBroadcastFanout,
  recoverActivePushBroadcastFanouts,
} from "../src/services/push-broadcast.service.js";
import { startTestDb, stopTestDb, resetTestDb, seedTenantUser } from "./helpers/db.js";

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

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });

test("maintenance recovery re-enqueues after crash window without direct helper-only proof", async () => {
  await resetTestDb();
  const { tenant, branch, user } = await seedTenantUser();
  const total = 800;
  await bulkSeedEligibleCustomers({
    tenantId: tenant._id,
    branchId: branch._id,
    count: total,
    idPrefix: "R",
    devicePrefix: "staging-fcm-r-",
  });
  const broadcast = await PushBroadcast.create({
    _id: createId("pbc"),
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "Recover via maintenance",
    body: "Body",
    audience: "ALL_DEVICES",
    status: JobStatus.QUEUED,
    stats: { audienceCount: total, messagesQueued: 0, delivered: 0, failed: 0 },
  });
  await processPushBroadcastFanout(broadcast._id, "page_one");
  await PushBroadcast.updateOne(
    { _id: broadcast._id },
    {
      $set: { fanoutContinuationPending: true },
      $unset: { leaseOwner: "", leaseExpiresAt: "" },
    },
  );
  await processMaintenance({ name: "push-broadcast-recover", data: {} });
  let guard = 0;
  while (guard < 15) {
    const row = await PushBroadcast.findById(broadcast._id).lean();
    if (row.status === JobStatus.COMPLETED) break;
    await processPushBroadcastFanout(broadcast._id, `recover_worker_${guard}`);
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
});

test("duplicate recovery scheduler passes do not multiply unique message rows", async () => {
  await resetTestDb();
  const { tenant, branch, user } = await seedTenantUser();
  await bulkSeedEligibleCustomers({
    tenantId: tenant._id,
    branchId: branch._id,
    count: 450,
    idPrefix: "D",
    devicePrefix: "staging-fcm-d-",
  });
  const broadcast = await PushBroadcast.create({
    _id: createId("pbc"),
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "Dedupe recovery",
    body: "Body",
    audience: "ALL_DEVICES",
    status: JobStatus.QUEUED,
    fanoutContinuationPending: true,
    stats: { audienceCount: 450, messagesQueued: 0, delivered: 0, failed: 0 },
  });
  await recoverActivePushBroadcastFanouts({ limit: 10 });
  await recoverActivePushBroadcastFanouts({ limit: 10 });
  await processPushBroadcastFanout(broadcast._id, "worker_dup_1");
  const afterFirst = await Message.countDocuments({
    tenantId: tenant._id,
    "templateParams.broadcastId": broadcast._id,
  });
  await processPushBroadcastFanout(broadcast._id, "worker_dup_2");
  const afterSecond = await Message.countDocuments({
    tenantId: tenant._id,
    "templateParams.broadcastId": broadcast._id,
  });
  assert.ok(afterSecond >= afterFirst);
  assert.equal(
    await OutboxEvent.countDocuments({ tenantId: tenant._id, topic: "message.send" }),
    0,
  );
});

test("stale lease token cannot mutate chunk attempts or fail campaign", async () => {
  await resetTestDb();
  const { tenant, user } = await seedTenantUser();
  const broadcast = await PushBroadcast.create({
    _id: createId("pbc"),
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "Stale error fence",
    body: "Body",
    audience: "ALL_DEVICES",
    status: JobStatus.PROCESSING,
    chunkAttempts: 1,
    leaseOwner: "pbclease_new",
    stats: { audienceCount: 1, messagesQueued: 0, delivered: 0, failed: 0 },
  });
  const stale = await PushBroadcast.updateOne(
    {
      _id: broadcast._id,
      tenantId: tenant._id,
      leaseOwner: "pbclease_stale",
      status: { $in: [JobStatus.QUEUED, JobStatus.PROCESSING] },
    },
    {
      $set: {
        chunkAttempts: 99,
        error: "stale",
        status: JobStatus.FAILED,
      },
    },
  );
  assert.equal(stale.modifiedCount, 0);
  const row = await PushBroadcast.findById(broadcast._id).lean();
  assert.equal(row.chunkAttempts, 1);
  assert.equal(row.status, JobStatus.PROCESSING);
  await clearBroadcastLease({
    broadcastId: broadcast._id,
    tenantId: tenant._id,
    leaseToken: "pbclease_stale",
  });
  const afterClear = await PushBroadcast.findById(broadcast._id).lean();
  assert.equal(afterClear.leaseOwner, "pbclease_new");
});

test("completed broadcast is ignored by recovery scan", async () => {
  await resetTestDb();
  const { tenant, user } = await seedTenantUser();
  await PushBroadcast.create({
    _id: createId("pbc"),
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "Done",
    body: "Body",
    audience: "ALL_DEVICES",
    status: JobStatus.COMPLETED,
    fanoutContinuationPending: true,
    stats: { audienceCount: 1, messagesQueued: 1, delivered: 0, failed: 0 },
  });
  const result = await recoverActivePushBroadcastFanouts({ limit: 10 });
  assert.equal(result.enqueued, 0);
});
