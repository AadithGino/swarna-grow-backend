import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import IORedis from "ioredis";
import { env } from "../src/config/env.js";
import { connectRedis, disconnectRedis, redisReady } from "../src/config/redis.js";
import {
  clearRateLimitStoresForTests,
  createRateLimitStore,
  loginRateLimit,
  publicRateLimit,
  tenantResolveRateLimit,
} from "../src/middlewares/security.middleware.js";

async function redisAvailable() {
  const probe = new IORedis(env.REDIS_URL, {
    connectTimeout: 1000,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  try {
    await probe.connect();
    await probe.ping();
    await probe.quit();
    return true;
  } catch {
    try { await probe.quit(); } catch { /* ignore */ }
    return false;
  }
}

test("createRateLimitStore returns distinct instances per prefix", () => {
  const prefixes = ["public", "otp-req", "otp-verify", "login", "tenant-resolve"];
  const stores = prefixes.map((prefix) => createRateLimitStore(prefix));
  assert.equal(new Set(stores).size, prefixes.length);
});

test("tenant resolve applies one rate limiter increment per request", async () => {
  const router = express.Router();
  router.use(publicRateLimit);
  router.get("/tenants/resolve", tenantResolveRateLimit, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  const app = express();
  app.set("trust proxy", 1);
  app.use(router);

  const response = await request(app).get("/tenants/resolve?mobile=%2B919800000001").expect(200);
  const headers = response.headers.ratelimit;
  const headerList = Array.isArray(headers) ? headers : headers ? [headers] : [];
  assert.equal(headerList.length, 1, "expected exactly one ratelimit header (no stacked public + dedicated limiter)");
});

test("increment uses memory when Redis is not ready in non-production", async () => {
  await disconnectRedis();
  const store = createRateLimitStore(`memory-only-${Date.now()}`);
  store.init({ windowMs: 60_000 });
  const hit = await store.increment("127.0.0.1");
  assert.equal(hit.totalHits, 1);
});

test("teardown clears rate-limit stores without late Redis commands after disconnect", async (t) => {
  if (!(await redisAvailable())) {
    t.skip("Redis not available");
    return;
  }
  const connected = await connectRedis().catch(() => false);
  if (!connected || !redisReady()) {
    t.skip("Redis not available");
    return;
  }
  const store = createRateLimitStore(`teardown-${Date.now()}`);
  store.init({ windowMs: 60_000 });
  await store.increment("teardown-key");
  await clearRateLimitStoresForTests();
  await disconnectRedis();
  await store.increment("after-teardown");
  assert.ok(true);
});

test("redis-backed stores with distinct prefixes increment independently", async (t) => {
  if (!(await redisAvailable())) {
    t.skip("Redis not available");
    return;
  }
  const connected = await connectRedis().catch(() => false);
  if (!connected || !redisReady()) {
    t.skip("Redis not available");
    return;
  }
  t.after(async () => {
    await clearRateLimitStoresForTests();
    await disconnectRedis();
  });

  const suffix = String(Date.now());
  const storeA = createRateLimitStore(`indep-a-${suffix}`);
  const storeB = createRateLimitStore(`indep-b-${suffix}`);
  const options = { windowMs: 60_000 };
  storeA.init(options);
  storeB.init(options);

  await storeA.increment("127.0.0.1");
  const b1 = await storeB.increment("127.0.0.1");
  assert.equal(b1.totalHits, 1);
  const a2 = await storeA.increment("127.0.0.1");
  assert.equal(a2.totalHits, 2);
});

test("login and tenant resolve limiters are separate middleware instances", () => {
  assert.notEqual(loginRateLimit, tenantResolveRateLimit);
  assert.notEqual(loginRateLimit, publicRateLimit);
});
