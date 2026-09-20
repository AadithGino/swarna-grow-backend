import test from "node:test";
import assert from "node:assert/strict";
import IORedis from "ioredis";
import { env } from "../src/config/env.js";
import { connectRedis, disconnectRedis, getRedis, redisReady } from "../src/config/redis.js";
import { computeReadiness } from "../src/lib/readiness.js";
import {
  publishWorkerRoleHeartbeat,
  requiredWorkerRolesReady,
  workerRoleHeartbeatKey,
} from "../src/lib/worker-heartbeat.js";

test.before(async () => {
  const probe = new IORedis(env.REDIS_URL, { connectTimeout: 1500, maxRetriesPerRequest: 1, lazyConnect: true });
  await probe.connect();
  await probe.quit();
  await connectRedis();
});

test.after(async () => {
  await disconnectRedis().catch(() => {});
});

test("production readiness fails when scheduler/payments worker roles are missing", async () => {
  assert.ok(redisReady());
  await getRedis().del(workerRoleHeartbeatKey("scheduler"));
  await getRedis().del(workerRoleHeartbeatKey("payments"));
  const rolesOk = await requiredWorkerRolesReady(["scheduler", "payments"]);
  assert.equal(rolesOk, false);
  const state = computeReadiness({
    dbOk: true,
    redisOk: true,
    nodeEnv: "production",
    redisRequired: true,
    workersOk: true,
    workerRolesOk: rolesOk,
  });
  assert.equal(state.ready, false);
  assert.equal(state.data.workerRoles, "unavailable");
});

test("production readiness passes when both worker roles heartbeat", async () => {
  await publishWorkerRoleHeartbeat("scheduler");
  await publishWorkerRoleHeartbeat("payments");
  const rolesOk = await requiredWorkerRolesReady(["scheduler", "payments"]);
  assert.equal(rolesOk, true);
  const state = computeReadiness({
    dbOk: true,
    redisOk: true,
    nodeEnv: "production",
    redisRequired: true,
    workersOk: true,
    workerRolesOk: rolesOk,
  });
  assert.equal(state.ready, true);
  assert.equal(state.data.workerRoles, "ready");
});
