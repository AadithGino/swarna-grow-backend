import test from "node:test";
import assert from "node:assert/strict";
import IORedis from "ioredis";
import { env } from "../src/config/env.js";
import { connectRedis, disconnectRedis, getRedis } from "../src/config/redis.js";
import {
  MaintenanceScanStream,
  acquireMaintenanceScanLease,
  clearMaintenanceScanCursor,
  clearMaintenanceScanLease,
  maintenanceScanCursorRedisKey,
  maintenanceScanLeaseRedisKey,
  readMaintenanceScanCursor,
  releaseMaintenanceScanLease,
  runRotatingMaintenanceScan,
} from "../src/lib/maintenance-scan-cursor.js";

test.before(async () => {
  const probe = new IORedis(env.REDIS_URL, { connectTimeout: 1500, maxRetriesPerRequest: 1, lazyConnect: true });
  await probe.connect();
  await probe.ping();
  await probe.quit();
  await connectRedis();
});
test.after(async () => {
  await disconnectRedis().catch(() => {});
});

test.beforeEach(async () => {
  for (const stream of Object.values(MaintenanceScanStream)) {
    await clearMaintenanceScanCursor(stream);
    await clearMaintenanceScanLease(stream);
  }
});

function defer() {
  let release = () => {};
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("only one concurrent scan runs batches; second reports lease busy", async () => {
  const stream = MaintenanceScanStream.DEFAULTING;
  const hold = defer();
  let firstBatchEntered = false;
  let secondBatchEntered = false;

  const firstRun = runRotatingMaintenanceScan({
    stream,
    maxBatches: 1,
    runBatch: async () => {
      firstBatchEntered = true;
      await hold.promise;
      return {
        processed: 1,
        scanned: 1,
        lastCursor: "sch_01AAAA0000000001",
        hasMore: true,
      };
    },
  });

  while (!firstBatchEntered) {
    await new Promise((r) => setTimeout(r, 0));
  }

  const secondRun = await runRotatingMaintenanceScan({
    stream,
    maxBatches: 1,
    runBatch: async () => {
      secondBatchEntered = true;
      return { processed: 0, scanned: 1, lastCursor: "sch_01BBBB0000000002", hasMore: true };
    },
  });

  assert.equal(secondRun.leaseBusy, true);
  assert.equal(secondRun.batchesRun, 0);
  assert.equal(secondBatchEntered, false);

  hold.release();
  const firstResult = await firstRun;
  assert.equal(firstResult.batchesRun, 1);
  const after = await readMaintenanceScanCursor(stream);
  assert.equal(after.cursor, "sch_01AAAA0000000001");
});

test("active maintenance scan lease cannot be stolen", async () => {
  const stream = MaintenanceScanStream.FLEXIBLE_LOCK;
  const owner = await acquireMaintenanceScanLease(stream);
  assert.ok(owner.acquired);
  const rival = await acquireMaintenanceScanLease(stream);
  assert.equal(rival.acquired, false);
  await releaseMaintenanceScanLease(stream, owner.token);
});

test("expired maintenance scan lease is reclaimable", async () => {
  const stream = MaintenanceScanStream.PAYMENT_EXPIRY_INTENT;
  const owner = await acquireMaintenanceScanLease(stream);
  assert.ok(owner.acquired);
  await getRedis().pexpire(maintenanceScanLeaseRedisKey(stream), 1);
  await new Promise((r) => setTimeout(r, 15));
  const next = await acquireMaintenanceScanLease(stream);
  assert.equal(next.acquired, true);
  await releaseMaintenanceScanLease(stream, next.token);
});

test("former owner cannot write cursor after losing lease", async () => {
  const stream = MaintenanceScanStream.PAYMENT_EXPIRY_LINK;
  const first = await acquireMaintenanceScanLease(stream);
  assert.ok(first.acquired);
  await releaseMaintenanceScanLease(stream, first.token);
  const second = await acquireMaintenanceScanLease(stream);
  assert.ok(second.acquired);

  const writeScript = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("SET", KEYS[2], ARGV[2], "EX", 3600)
    end
    return 0
  `;
  const staleWrite = await getRedis().eval(
    writeScript,
    2,
    maintenanceScanLeaseRedisKey(stream),
    maintenanceScanCursorRedisKey(stream),
    first.token,
    "sch_01STALE0000000001",
  );
  assert.equal(staleWrite, 0);
  const cursor = await readMaintenanceScanCursor(stream);
  assert.equal(cursor.cursor, null);
  await releaseMaintenanceScanLease(stream, second.token);
});

test("token-checked release cannot delete another owners lease", async () => {
  const stream = MaintenanceScanStream.DEFAULTING;
  const owner = await acquireMaintenanceScanLease(stream);
  assert.ok(owner.acquired);
  const released = await releaseMaintenanceScanLease(stream, "wrong-token");
  assert.equal(released, false);
  const stillHeld = await acquireMaintenanceScanLease(stream);
  assert.equal(stillHeld.acquired, false);
  await releaseMaintenanceScanLease(stream, owner.token);
});

test("maintenance scan leases are independent per stream", async () => {
  const hold = defer();
  let flexBatch = false;
  const flexRun = runRotatingMaintenanceScan({
    stream: MaintenanceScanStream.FLEXIBLE_LOCK,
    maxBatches: 1,
    runBatch: async () => {
      flexBatch = true;
      await hold.promise;
      return { scanned: 1, lastCursor: "sch_01FLEX0000000001", hasMore: true };
    },
  });
  while (!flexBatch) {
    await new Promise((r) => setTimeout(r, 0));
  }
  const defaultingRun = await runRotatingMaintenanceScan({
    stream: MaintenanceScanStream.DEFAULTING,
    maxBatches: 1,
    runBatch: async () => ({ scanned: 1, lastCursor: "sch_01DEF00000000001", hasMore: false }),
  });
  assert.equal(defaultingRun.leaseBusy, false);
  assert.equal(defaultingRun.batchesRun, 1);
  hold.release();
  await flexRun;
});
