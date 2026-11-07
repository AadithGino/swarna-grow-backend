/**
 * AUD-04/05 — OTP atomicity and budget behavior with real Redis.
 */
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import IORedis from "ioredis";
import { env } from "../src/config/env.js";
import { connectRedis, disconnectRedis, getRedis, redisReady } from "../src/config/redis.js";
import { otpProvider } from "../src/integrations/otp.provider.js";

const testEnv = {
  ...env,
  NODE_ENV: "test",
  OTP_PROVIDER: "mock",
  PROVIDER_MODE: "mock",
  OTP_TTL_SECONDS: 300,
  OTP_RESEND_COOLDOWN_SECONDS: 0,
  OTP_MAX_ATTEMPTS: 5,
  OTP_MC_VERIFY_LEASE_MS: 45_000,
  OTP_BUDGET_WINDOW_SECONDS: 900,
  OTP_BUDGET_MAX_PER_DESTINATION: 500,
  OTP_BUDGET_MAX_PER_IP: 500,
  OTP_BUDGET_MAX_PER_TENANT: 500,
  OTP_BUDGET_MAX_PER_PROVIDER: 5000,
};

async function ensureRedisUp() {
  const probe = new IORedis(env.REDIS_URL, { connectTimeout: 1500, maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await probe.connect();
    await probe.ping();
    await probe.quit();
  } catch {
    return false;
  }
  return true;
}

test.before(async () => {
  assert.ok(await ensureRedisUp(), "Redis required for otp-phase3 tests (local REDIS_URL)");
  await connectRedis();
});

test.after(async () => {
  if (redisReady()) {
    await getRedis().quit().catch(() => {});
  }
  await disconnectRedis().catch(() => {});
});

test.beforeEach(async () => {
  if (redisReady()) {
    await getRedis().flushdb();
  }
});

test("20 concurrent valid verifications: single logical success", async () => {
  const params = {
    tenantId: "t_conc",
    tenantCode: "CONC",
    mobile: "+919911223344",
    purpose: "LOGIN",
  };
  const sent = await otpProvider.send(params, { env: testEnv });
  const tasks = Array.from({ length: 20 }, () =>
    otpProvider.verify({ ...params, otp: "123456", otpId: sent.otpId }, { env: testEnv }),
  );
  const results = await Promise.all(tasks);
  const wins = results.filter(Boolean).length;
  assert.equal(wins, 1);
});

test("concurrent invalid attempts at attempt cap do not grant access afterward", async () => {
  const params = {
    tenantId: "t_bad",
    tenantCode: "BADX",
    mobile: "+919922334455",
    purpose: "LOGIN",
  };
  const sent = await otpProvider.send(params, { env: testEnv });
  const wrong = "000000";
  await Promise.all(Array.from({ length: 5 }, () =>
    otpProvider.validate({ ...params, otp: wrong, otpId: sent.otpId }, { env: testEnv }).then((r) => r.ok),
  ));
  await Promise.all(Array.from({ length: 10 }, () =>
    otpProvider.validate({ ...params, otp: wrong, otpId: sent.otpId }, { env: testEnv }).then((r) => r.ok),
  ));
  const ok = await otpProvider.verify({ ...params, otp: "123456", otpId: sent.otpId }, { env: testEnv });
  assert.equal(ok, false);
});

test("resend replaces challenge: old otpId cannot verify after new send", async () => {
  const params = {
    tenantId: "t_rs",
    tenantCode: "RSND",
    mobile: "+919933445566",
    purpose: "SIGNUP",
  };
  const first = await otpProvider.send(params, { env: testEnv });
  const second = await otpProvider.send(params, { env: testEnv });
  assert.notEqual(first.otpId, second.otpId);
  const staleOk = await otpProvider.verify({ ...params, otp: "123456", otpId: first.otpId }, { env: testEnv });
  assert.equal(staleOk, false);
  const freshOk = await otpProvider.verify({ ...params, otp: "123456", otpId: second.otpId }, { env: testEnv });
  assert.equal(freshOk, true);
});

test("aggregate IP budget: rotating mobiles still hits IP limit", async () => {
  const tight = {
    ...testEnv,
    OTP_BUDGET_MAX_PER_IP: 3,
  };
  const tenantId = "t_ip";
  for (let i = 0; i < 3; i += 1) {
    await otpProvider.send(
      { tenantId, tenantCode: "IPLIM", mobile: `+91995${String(30000 + i).slice(-5)}`, purpose: "LOGIN" },
      { env: tight, request: { ip: "203.0.113.50" } },
    );
  }
  await assert.rejects(
    () =>
      otpProvider.send(
        { tenantId, tenantCode: "IPLIM", mobile: "+919956667788", purpose: "LOGIN" },
        { env: tight, request: { ip: "203.0.113.50" } },
      ),
    (e) => e.code === "OTP_RATE_LIMITED",
  );
});

test("independent tenant isolation under shared IP", async () => {
  const tight = {
    ...testEnv,
    OTP_BUDGET_MAX_PER_TENANT: 2,
  };
  await otpProvider.send(
    { tenantId: "t_a", tenantCode: "ISOA", mobile: "+919961112233", purpose: "LOGIN" },
    { env: tight, request: { ip: "203.0.113.60" } },
  );
  await otpProvider.send(
    { tenantId: "t_b", tenantCode: "ISOB", mobile: "+919962223344", purpose: "LOGIN" },
    { env: tight, request: { ip: "203.0.113.60" } },
  );
  assert.ok(
    await otpProvider.send(
      { tenantId: "t_a", tenantCode: "ISOA", mobile: "+919964445566", purpose: "LOGIN" },
      { env: tight, request: { ip: "203.0.113.60" } },
    ),
  );
});

test("two processes share tenant budget via Redis", async () => {
  const shared = {
    ...testEnv,
    OTP_BUDGET_MAX_PER_TENANT: 2,
  };
  const childPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "otp-phase3-budget-child.mjs");
  const params = {
    tenantId: "t_fork",
    tenantCode: "FRK",
    mobile: "+919977889900",
    purpose: "LOGIN",
  };

  const runChild = () =>
    new Promise((resolve, reject) => {
      const child = fork(childPath, [], {
        env: {
          ...process.env,
          OTP_PHASE3_ENV: JSON.stringify(shared),
          OTP_PHASE3_PARAMS: JSON.stringify(params),
          OTP_PHASE3_IP: "198.51.100.2",
          REDIS_URL: env.REDIS_URL,
        },
        stdio: "pipe",
      });
      let err = "";
      child.stderr?.on("data", (d) => { err += String(d); });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err || `child exit ${code}`))));
    });

  await runChild();
  await otpProvider.send(
    { ...params, mobile: "+919988990011" },
    { env: shared, request: { ip: "198.51.100.3" } },
  );
  await assert.rejects(
    () => otpProvider.send({ ...params, mobile: "+919990011223" }, { env: shared, request: { ip: "198.51.100.4" } }),
    (e) => e.code === "OTP_RATE_LIMITED",
  );
});

test("Redis unavailable in production mode fails closed on send", async () => {
  await disconnectRedis();
  await assert.rejects(
    () =>
      otpProvider.send(
        { tenantId: "t_x", tenantCode: "X", mobile: "+919944556677", purpose: "LOGIN" },
        { env: { ...testEnv, NODE_ENV: "production" } },
      ),
    (e) => e.code === "OTP_REDIS_UNAVAILABLE",
  );
  await connectRedis();
  await getRedis().flushdb();
});
