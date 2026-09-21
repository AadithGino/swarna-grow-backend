import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import argon2 from "argon2";
import { Customer, PasswordResetToken, Tenant } from "../src/models/index.js";
import { CustomerLoginMode } from "../src/constants/enums.js";
import { customerPasswordLoginBody } from "../src/validators/common.validators.js";
import { createId } from "../src/lib/ids.js";
import { sha256 } from "../src/lib/crypto.js";
import { otpProvider } from "../src/integrations/otp.provider.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("public set-password without resetToken is rejected", async () => {
  const response = await request(app)
    .post("/api/v1/public/auth/set-password")
    .send({ mobile: "+919888877766", tenantCode: "TESTCO", password: "1234" })
    .expect(400);
  assert.equal(response.body.success, false);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
  assert.notEqual(response.status, 200);
});

test("forgot-password returns identical 202 whether or not the mobile exists", async () => {
  await seedTenantUser({ mobile: "+919888877766" });
  const known = await request(app)
    .post("/api/v1/auth/forgot-password")
    .set("x-idempotency-key", randomUUID())
    .send({ tenantCode: "TESTCO", mobile: "+919888877766", deviceId: "device-1" })
    .expect(202);
  const unknown = await request(app)
    .post("/api/v1/auth/forgot-password")
    .set("x-idempotency-key", randomUUID())
    .send({ tenantCode: "TESTCO", mobile: "+919000000000", deviceId: "device-1" })
    .expect(202);
  assert.deepEqual(known.body.data, unknown.body.data);
  assert.equal(known.body.success, true);
});

test("password reset token works once and rejects reuse", async () => {
  const { user, tenant } = await seedTenantUser({ mobile: "+919888877766" });
  const sent = await otpProvider.send({
    tenantId: tenant._id,
    tenantCode: "TESTCO",
    mobile: user.mobile,
    purpose: "PASSWORD_RESET",
  });
  const verified = await request(app)
    .post("/api/v1/public/auth/otp/verify")
    .set("x-idempotency-key", randomUUID())
    .send({
      tenantCode: "TESTCO",
      mobile: user.mobile,
      purpose: "PASSWORD_RESET",
      deviceId: "device-1",
      otp: "123456",
      otpId: sent.otpId,
    })
    .expect(200);
  const resetToken = verified.body.data.resetToken;
  assert.ok(resetToken?.length >= 32);

  const first = await request(app)
    .post("/api/v1/public/auth/set-password")
    .send({ resetToken, password: "5678" })
    .expect(200);
  assert.equal(first.body.data.passwordSet, true);

  const second = await request(app)
    .post("/api/v1/public/auth/set-password")
    .send({ resetToken, password: "9012" })
    .expect(401);
  assert.equal(second.body.error.code, "UNAUTHENTICATED");
});

test("SIGNUP OTP verify signs in when mobile is already registered", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const mobile = "+919847012345";
  await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: "C9001",
    name: "Existing",
    mobile,
    status: "ACTIVE",
  });
  const requested = await request(app)
    .post("/api/v1/public/auth/otp/request")
    .set("x-idempotency-key", randomUUID())
    .send({ tenantCode: "TESTCO", mobile, purpose: "SIGNUP", deviceId: "customer-web" })
    .expect(202);
  assert.equal(requested.body.data.isRegistered, true);
  const verified = await request(app)
    .post("/api/v1/public/auth/otp/verify")
    .set("x-idempotency-key", randomUUID())
    .send({
      tenantCode: "TESTCO",
      mobile,
      purpose: "SIGNUP",
      deviceId: "customer-web",
      otp: "123456",
      otpId: requested.body.data.otpId,
    })
    .expect(200);
  assert.equal(verified.body.data.isNewCustomer, false);
  assert.ok(verified.body.data.accessToken);
});

test("customer SIGNUP OTP verify creates session", async () => {
  await seedTenantUser({});
  const mobile = `+9199${String(Date.now()).slice(-8)}`;
  const requested = await request(app)
    .post("/api/v1/public/auth/otp/request")
    .set("x-idempotency-key", randomUUID())
    .send({ tenantCode: "TESTCO", mobile, purpose: "SIGNUP", deviceId: "customer-web" })
    .expect(202);
  const verified = await request(app)
    .post("/api/v1/public/auth/otp/verify")
    .set("x-idempotency-key", randomUUID())
    .send({
      tenantCode: "TESTCO",
      mobile,
      purpose: "SIGNUP",
      deviceId: "customer-web",
      otp: "123456",
      otpId: requested.body.data.otpId,
    })
    .expect(200);
  assert.equal(verified.body.data.isNewCustomer, true);
  assert.ok(verified.body.data.accessToken);
  assert.equal(verified.body.data.profileComplete, false);
});

test("weak customer password is rejected by validator", async () => {
  const parsed = customerPasswordLoginBody.safeParse({
    tenantCode: "TESTCO",
    mobile: "+919888877766",
    password: "123",
    deviceId: "customer-web",
  });
  assert.equal(parsed.success, false);
  const valid = customerPasswordLoginBody.safeParse({
    tenantCode: "TESTCO",
    mobile: "+919888877766",
    password: "1234",
    deviceId: "customer-web",
  });
  assert.equal(valid.success, true);
  const policy = await request(app).get("/api/v1/public/auth/password-policy").expect(200);
  assert.equal(policy.body.data.minLength, 4);
  assert.equal(policy.body.data.maxLength, 128);
  assert.equal(policy.body.data.numericOnly, true);
  assert.equal(policy.body.data.requireUppercase, false);
  assert.equal(policy.body.data.requireSymbol, false);
});

test("PASSWORD_ONLY login rejects mobile number as password when no hash exists", async () => {
  const { tenant, branch } = await seedTenantUser({});
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "operations.customerLoginMode": CustomerLoginMode.PASSWORD_ONLY } },
  );
  const mobile = "+919888800001";
  await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: "C8001",
    name: "Password Customer",
    mobile,
  });
  const mobileAsPassword = await request(app)
    .post("/api/v1/public/auth/login-password")
    .set("x-forwarded-for", "10.0.1.1")
    .send({ tenantCode: tenant.code, mobile, password: mobile, deviceId: "customer-web" });
  assert.notEqual(mobileAsPassword.status, 200);
  assert.ok(["VALIDATION_FAILED", "CUSTOMER_PASSWORD_NOT_SET"].includes(mobileAsPassword.body.error?.code));
  const withoutHash = await request(app)
    .post("/api/v1/public/auth/login-password")
    .set("x-forwarded-for", `10.${(Date.now() % 200) + 10}.1.2`)
    .send({ tenantCode: tenant.code, mobile, password: "1234", deviceId: "customer-web" })
    .expect(403);
  assert.equal(withoutHash.body.error.code, "CUSTOMER_PASSWORD_NOT_SET");
  const stored = await Customer.findOne({ mobile }).select("+passwordHash").lean();
  assert.ok(!stored.passwordHash);
});

test("customer login-password is rate limited after repeated failures", async () => {
  const { tenant, branch } = await seedTenantUser({});
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "operations.customerLoginMode": CustomerLoginMode.PASSWORD_ONLY } },
  );
  const mobile = "+919888800002";
  const password = "4321";
  await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: "C8002",
    name: "Rate Limited",
    mobile,
    passwordHash: await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
  });
  let lastStatus = 401;
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const response = await request(app)
      .post("/api/v1/public/auth/login-password")
      .set("x-forwarded-for", "10.0.2.1")
      .send({ tenantCode: tenant.code, mobile, password: "9999", deviceId: "rate-device" });
    lastStatus = response.status;
  }
  assert.equal(lastStatus, 429);
  assert.equal((await request(app)
    .post("/api/v1/public/auth/login-password")
    .set("x-forwarded-for", "10.0.2.1")
    .send({ tenantCode: tenant.code, mobile, password: "9999", deviceId: "rate-device" })).body.error.code, "RATE_LIMITED");
});

test("expired password reset token returns 401", async () => {
  const { user, tenant } = await seedTenantUser({ mobile: "+919888877755" });
  const raw = `${"a".repeat(40)}expired-token-value`;
  await PasswordResetToken.create({
    _id: createId("passwordReset"),
    userId: user._id,
    tenantId: tenant._id,
    tokenHash: sha256(raw),
    expiresAt: new Date(Date.now() - 60_000),
  });
  const response = await request(app)
    .post("/api/v1/public/auth/set-password")
    .send({ resetToken: raw, password: "5678" })
    .expect(401);
  assert.equal(response.body.error.code, "UNAUTHENTICATED");
});
