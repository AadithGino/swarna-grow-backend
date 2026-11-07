/**
 * Regression: AUD-04/05/09 gaps (single-use verify, atomic rollback/release, send gate, HTTP path).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import IORedis from "ioredis";
import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { connectRedis, disconnectRedis, getRedis, redisReady } from "../src/config/redis.js";
import { Customer, Session } from "../src/models/index.js";
import { otpProvider } from "../src/integrations/otp.provider.js";
import {
  budgetKeys,
  challengeRedisKey,
  releaseOtpSendReservation,
  resolveOtpBudgetContext,
  rollbackValidatedAtomic,
} from "../src/lib/otp-redis-store.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

const testEnv = {
  ...env,
  NODE_ENV: "test",
  OTP_PROVIDER: "mock",
  PROVIDER_MODE: "mock",
  OTP_TTL_SECONDS: 300,
  OTP_RESEND_COOLDOWN_SECONDS: 30,
  OTP_MAX_ATTEMPTS: 5,
  OTP_MC_VERIFY_LEASE_MS: 45_000,
  OTP_SESSION_ISSUE_LEASE_MS: 120_000,
  OTP_SEND_INFLIGHT_LEASE_MS: 30_000,
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
  assert.ok(await ensureRedisUp(), "Redis required");
  await connectRedis();
  await startTestDb();
});

test.after(async () => {
  if (redisReady()) await getRedis().quit().catch(() => {});
  await disconnectRedis().catch(() => {});
  await stopTestDb({ force: true });
});

test.beforeEach(async () => {
  await resetTestDb();
  if (redisReady()) await getRedis().flushdb();
});

test("20 concurrent customer HTTP verifies: at most one session", async () => {
  const { tenant, branch } = await seedTenantUser();
  const mobile = "+919812340099";
  await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile, name: "Conc" });
  const reqBody = {
    tenantCode: tenant.code,
    mobile,
    purpose: "LOGIN",
    deviceId: "customer-web",
  };
  const otpRes = await request(app)
    .post("/api/v1/public/auth/otp/request")
    .set("x-idempotency-key", randomUUID())
    .send(reqBody)
    .expect(202);

  const { otpId } = otpRes.body.data;
  assert.ok(otpId);

  const tasks = Array.from({ length: 20 }, () =>
    request(app)
      .post("/api/v1/public/auth/otp/verify")
      .set("x-idempotency-key", randomUUID())
      .send({
        ...reqBody,
        otp: "123456",
        otpId,
      }),
  );
  const responses = await Promise.all(tasks);
  const oks = responses.filter((r) => r.status === 200);
  assert.ok(oks.length <= 1, `expected at most one 200, got ${oks.length}`);
  const customer = await Customer.findOne({ tenantId: tenant._id, mobile }).lean();
  assert.ok(customer);
  const sessions = await Session.countDocuments({ customerId: customer._id, tenantId: tenant._id });
  assert.equal(sessions, oks.length);
});

test("rollbackValidated requires matching sessionToken when challenge is bound (AUD-05)", async () => {
  assert.ok(redisReady());
  const redis = getRedis();
  const params = {
    tenantId: "t_rb_tok",
    tenantCode: "TOKK",
    mobile: "+919800099911",
    purpose: "LOGIN",
  };
  const key = challengeRedisKey(params);
  const sent = await otpProvider.send({ ...params }, { env: testEnv });
  const sessionToken = randomUUID();
  const bound = await otpProvider.validateAndClaimSessionLease(
    { ...params, otp: "123456", otpId: sent.otpId },
    { env: testEnv },
    sessionToken,
  );
  assert.ok(bound.ok);
  const raw = await redis.get(key);
  const r = JSON.parse(raw);
  const va = Number(r.validatedAt);
  const withoutTok = await rollbackValidatedAtomic(redis, key, { otpId: sent.otpId, validatedAt: va });
  assert.equal(withoutTok.status, "noop");
  const wrongTok = await rollbackValidatedAtomic(redis, key, {
    otpId: sent.otpId,
    validatedAt: va,
    sessionToken: randomUUID(),
  });
  assert.equal(wrongTok.status, "noop");
  const withTok = await rollbackValidatedAtomic(redis, key, {
    otpId: sent.otpId,
    validatedAt: va,
    sessionToken,
  });
  assert.equal(withTok.status, "ok");
});

test("rollbackValidated ignores stale otpId / wrong validatedAt", async () => {
  assert.ok(redisReady());
  const redis = getRedis();
  const params = {
    tenantId: "t_rb",
    tenantCode: "ROLL",
    mobile: "+919800011122",
    purpose: "LOGIN",
  };
  const key = challengeRedisKey(params);
  const first = await otpProvider.send({ ...params }, { env: testEnv });
  await otpProvider.validate({ ...params, otp: "123456", otpId: first.otpId }, { env: testEnv });
  const raw = await redis.get(key);
  const r = JSON.parse(raw);
  const va = Number(r.validatedAt);
  const second = await otpProvider.send({ ...params }, { env: { ...testEnv, OTP_RESEND_COOLDOWN_SECONDS: 0 } });
  const stale = await rollbackValidatedAtomic(redis, key, { otpId: first.otpId, validatedAt: va });
  assert.equal(stale.status, "noop");
  const after = await redis.get(key);
  const r2 = JSON.parse(after);
  assert.equal(String(r2.otpId), String(second.otpId));
});

test("releaseOtpSendReservation is atomic under concurrent decrements", async () => {
  assert.ok(redisReady());
  const redis = getRedis();
  const params = {
    mobile: "+919811122233",
    countryCode: "91",
    tenantId: "t_rel",
    tenantCode: "RELX",
    provider: "mock",
    request: { ip: "198.18.1.1" },
  };
  const bc = resolveOtpBudgetContext(params);
  const keys = budgetKeys({
    countryCode: bc.countryCode,
    destinationId: bc.destinationId,
    ipBucket: bc.ipBucket,
    tenantScope: bc.tenantScope,
    providerScope: bc.providerScope,
    windowSec: 900,
    nowMs: Date.now(),
  });
  await redis.set(keys.destination, "2", "EX", 900);
  await redis.set(keys.ip, "2", "EX", 900);
  await redis.set(keys.tenant, "2", "EX", 900);
  await redis.set(keys.provider, "2", "EX", 900);
  await Promise.all([
    releaseOtpSendReservation(redis, keys),
    releaseOtpSendReservation(redis, keys),
  ]);
  const vals = await Promise.all([redis.get(keys.destination), redis.get(keys.ip), redis.get(keys.tenant), redis.get(keys.provider)]);
  assert.ok(vals.every((v) => v == null), `expected keys cleared, got ${JSON.stringify(vals)}`);
});

test("concurrent sends with cooldown: at most one succeeds", async () => {
  const params = {
    tenantId: "t_cd",
    tenantCode: "COOL",
    mobile: "+919822334455",
    purpose: "LOGIN",
  };
  const sends = await Promise.allSettled(
    Array.from({ length: 20 }, () => otpProvider.send(params, { env: testEnv, request: { ip: "203.0.113.77" } })),
  );
  const fulfilled = sends.filter((s) => s.status === "fulfilled");
  assert.equal(fulfilled.length, 1, `expected 1 successful send, got ${fulfilled.length}`);
});

test("delayed prepareSendSlot: after parallel send fills key, waiter hits cooldown not second dispatch", async () => {
  const params = {
    tenantId: "t_dly_gate",
    tenantCode: "DLYG",
    mobile: "+919877665544",
    purpose: "LOGIN",
  };
  let releaseBarrier;
  const barrier = new Promise((resolve) => {
    releaseBarrier = resolve;
  });
  const deferred = otpProvider.send(params, {
    env: testEnv,
    request: { ip: "203.0.113.10" },
    otpTestHooks: { beforeAcquireSendGate: () => barrier },
  });
  const first = await otpProvider.send(params, { env: testEnv, request: { ip: "203.0.113.11" } });
  assert.ok(first.otpId);
  releaseBarrier();
  await assert.rejects(async () => deferred, (e) => e.code === "OTP_RESEND_COOLDOWN");
});

test("HTTP verify: consume throws revokes issued session; retry succeeds with exactly one active session", async () => {
  const { tenant, branch } = await seedTenantUser();
  const mobile = "+919812349988";
  await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile, name: "ConsumeFail" });
  const reqBody = {
    tenantCode: tenant.code,
    mobile,
    purpose: "LOGIN",
    deviceId: "customer-web",
  };
  const otpRes = await request(app)
    .post("/api/v1/public/auth/otp/request")
    .set("x-idempotency-key", randomUUID())
    .send(reqBody)
    .expect(202);
  const { otpId } = otpRes.body.data;
  assert.ok(otpId);
  globalThis.__swarnaOtpTestConsumeThrowOnce = true;
  const failRes = await request(app)
    .post("/api/v1/public/auth/otp/verify")
    .set("x-idempotency-key", randomUUID())
    .send({ ...reqBody, otp: "123456", otpId });
  assert.equal(failRes.status, 500);
  globalThis.__swarnaOtpTestConsumeThrowOnce = false;
  const customer = await Customer.findOne({ tenantId: tenant._id, mobile }).lean();
  assert.ok(customer);
  const afterFail = await Session.countDocuments({
    customerId: customer._id,
    tenantId: tenant._id,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  assert.equal(afterFail, 0);
  const okRes = await request(app)
    .post("/api/v1/public/auth/otp/verify")
    .set("x-idempotency-key", randomUUID())
    .send({ ...reqBody, otp: "123456", otpId });
  assert.equal(okRes.status, 200);
  const afterOk = await Session.countDocuments({
    customerId: customer._id,
    tenantId: tenant._id,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  assert.equal(afterOk, 1);
});

test("HTTP verify: non-ok consume revokes issued session; retry succeeds with exactly one active session", async () => {
  const { tenant, branch } = await seedTenantUser();
  const mobile = "+919812349977";
  await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile, name: "ConsumeNonOk" });
  const reqBody = {
    tenantCode: tenant.code,
    mobile,
    purpose: "LOGIN",
    deviceId: "customer-web",
  };
  const otpRes = await request(app)
    .post("/api/v1/public/auth/otp/request")
    .set("x-idempotency-key", randomUUID())
    .send(reqBody)
    .expect(202);
  const { otpId } = otpRes.body.data;
  assert.ok(otpId);
  globalThis.__swarnaOtpTestConsumeFailOnce = true;
  const failRes = await request(app)
    .post("/api/v1/public/auth/otp/verify")
    .set("x-idempotency-key", randomUUID())
    .send({ ...reqBody, otp: "123456", otpId });
  assert.equal(failRes.status, 401);
  globalThis.__swarnaOtpTestConsumeFailOnce = false;
  const customer = await Customer.findOne({ tenantId: tenant._id, mobile }).lean();
  assert.ok(customer);
  const afterFail = await Session.countDocuments({
    customerId: customer._id,
    tenantId: tenant._id,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  assert.equal(afterFail, 0);
  const okRes = await request(app)
    .post("/api/v1/public/auth/otp/verify")
    .set("x-idempotency-key", randomUUID())
    .send({ ...reqBody, otp: "123456", otpId });
  assert.equal(okRes.status, 200);
  const afterOk = await Session.countDocuments({
    customerId: customer._id,
    tenantId: tenant._id,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  assert.equal(afterOk, 1);
});

test("HTTP verify: session revoke mismatch leaves challenge claimed; retry cannot create active session", async () => {
  const { tenant, branch } = await seedTenantUser();
  const mobile = "+919812349966";
  await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile, name: "RevokeMismatch" });
  const reqBody = {
    tenantCode: tenant.code,
    mobile,
    purpose: "LOGIN",
    deviceId: "customer-web",
  };
  const otpRes = await request(app)
    .post("/api/v1/public/auth/otp/request")
    .set("x-idempotency-key", randomUUID())
    .send(reqBody)
    .expect(202);
  const { otpId } = otpRes.body.data;
  assert.ok(otpId);
  globalThis.__swarnaOtpTestConsumeFailOnce = true;
  globalThis.__swarnaOtpTestSessionRevokeNoMatchOnce = true;
  try {
    const failRes = await request(app)
      .post("/api/v1/public/auth/otp/verify")
      .set("x-idempotency-key", randomUUID())
      .send({ ...reqBody, otp: "123456", otpId });
    assert.equal(failRes.status, 500);
  } finally {
    globalThis.__swarnaOtpTestConsumeFailOnce = false;
    globalThis.__swarnaOtpTestSessionRevokeNoMatchOnce = false;
  }
  const customer = await Customer.findOne({ tenantId: tenant._id, mobile }).lean();
  assert.ok(customer);
  const sessionsAfter = await Session.countDocuments({
    customerId: customer._id,
    tenantId: tenant._id,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  assert.equal(sessionsAfter, 1, "provisional session remains when revoke matchedCount !== 1");
  const retryRes = await request(app)
    .post("/api/v1/public/auth/otp/verify")
    .set("x-idempotency-key", randomUUID())
    .send({ ...reqBody, otp: "123456", otpId });
  assert.equal(retryRes.status, 401);
  const sessionsAfterRetry = await Session.countDocuments({
    customerId: customer._id,
    tenantId: tenant._id,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  assert.equal(
    sessionsAfterRetry,
    sessionsAfter,
    "retry must not issue another active session while challenge stays claimed",
  );
});

test("aggregate IP budget still limits rotating destinations (3 sends, 4th rate limited)", async () => {
  const tight = {
    ...testEnv,
    OTP_BUDGET_MAX_PER_IP: 3,
  };
  const tenantId = "t_ip_gate";
  for (let i = 0; i < 3; i += 1) {
    await otpProvider.send(
      { tenantId, tenantCode: "IPGT", mobile: `+91995${String(40000 + i).slice(-5)}`, purpose: "LOGIN" },
      { env: tight, request: { ip: "203.0.113.99" } },
    );
  }
  await assert.rejects(
    () =>
      otpProvider.send(
        { tenantId, tenantCode: "IPGT", mobile: "+919956667788", purpose: "LOGIN" },
        { env: tight, request: { ip: "203.0.113.99" } },
      ),
    (e) => e.code === "OTP_RATE_LIMITED",
  );
});
