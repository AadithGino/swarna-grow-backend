import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { Customer, PasswordResetToken } from "../src/models/index.js";
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
    .send({ mobile: "+919888877766", tenantCode: "TESTCO", password: "NewSecure!123" })
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
    .send({ resetToken, password: "BrandNew!Pass1" })
    .expect(200);
  assert.equal(first.body.data.passwordSet, true);

  const second = await request(app)
    .post("/api/v1/public/auth/set-password")
    .send({ resetToken, password: "Another!Pass12" })
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
    .send({ resetToken: raw, password: "BrandNew!Pass1" })
    .expect(401);
  assert.equal(response.body.error.code, "UNAUTHENTICATED");
});
