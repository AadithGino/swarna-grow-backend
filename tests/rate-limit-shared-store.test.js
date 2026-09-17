import test from "node:test";
import express from "express";
import request from "supertest";
import IORedis from "ioredis";
import rateLimit, { MemoryStore } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { env } from "../src/config/env.js";
import { connectRedis, disconnectRedis, getRedis, redisReady } from "../src/config/redis.js";

class RedisOrMemoryStore {
  constructor(prefix) {
    this.memory = new MemoryStore();
    this.redis = new RedisStore({
      prefix: `rl:test:${prefix}:`,
      sendCommand: (command, ...args) => getRedis().call(command, ...args),
    });
  }
  init(options) {
    this.memory.init(options);
    return this.redis.init(options);
  }
  increment(key) {
    if (redisReady()) return this.redis.increment(key);
    return this.memory.increment(key);
  }
  decrement(key) {
    if (redisReady()) return this.redis.decrement(key);
    return this.memory.decrement(key);
  }
  resetKey(key) {
    if (redisReady()) return this.redis.resetKey(key);
    return this.memory.resetKey(key);
  }
}

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

test("two limiter instances share counts through redis", async (t) => {
  if (!(await redisAvailable())) {
    t.skip("Redis not available");
    return;
  }
  const connected = await connectRedis().catch(() => false);
  if (!connected || !redisReady()) {
    t.skip("Redis not available");
    return;
  }
  const store = new RedisOrMemoryStore(`shared-${Date.now()}`);
  const makeApp = () => {
    const app = express();
    app.set("trust proxy", 1);
    app.get("/hit", rateLimit({
      windowMs: 60_000,
      limit: 2,
      standardHeaders: false,
      legacyHeaders: false,
      store,
    }), (_req, res) => res.status(200).send("ok"));
    return app;
  };
  const replicaA = makeApp();
  const replicaB = makeApp();
  await request(replicaA).get("/hit").expect(200);
  await request(replicaA).get("/hit").expect(200);
  await request(replicaB).get("/hit").expect(429);
  await disconnectRedis();
});
