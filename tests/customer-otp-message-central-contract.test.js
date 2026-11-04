/**
 * Customer mobile + web must keep using POST /public/auth/otp/* unchanged when
 * OTP delivery switches to per-tenant Message Central (VerifyNow).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { Customer, Tenant } from "../src/models/index.js";
import { seal } from "../src/lib/crypto.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

const OTP_REQUEST_RESPONSE_KEYS = [
  "otpId",
  "channel",
  "maskedMobile",
  "resendAvailableInSeconds",
  "attemptsAllowed",
  "isRegistered",
  "expiresInSeconds",
];

const OTP_VERIFY_SESSION_KEYS = [
  "accessToken",
  "refreshToken",
  "customer",
  "tenant",
  "tenantCapabilities",
  "isNewCustomer",
  "profileComplete",
];

function installMessageCentralFetchMock() {
  return async (url) => {
    if (String(url).includes("/authentication/token")) {
      return { ok: true, text: async () => JSON.stringify({ status: 200, token: "mc-test-token" }) };
    }
    if (String(url).includes("/verification/v3/send")) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          responseCode: 200,
          message: "SUCCESS",
          data: { verificationId: "mc-verification-1" },
        }),
      };
    }
    if (String(url).includes("/validateOtp")) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          message: "SUCCESS",
          data: { verificationStatus: "VERIFICATION_COMPLETED" },
        }),
      };
    }
    throw new Error(`Unexpected fetch URL in MC contract test: ${url}`);
  };
}

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

test("public OTP request/verify payloads unchanged with Message Central delivery", async () => {
  const fetchImpl = installMessageCentralFetchMock();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;

  try {
    const { tenant, branch } = await seedTenantUser({});
    await Tenant.findByIdAndUpdate(tenant._id, {
      $set: {
        "integrationSecrets.messageCentral": {
          provider: "MESSAGE_CENTRAL",
          customerId: "C-CONTRACT",
          keySealed: seal("mc-key-material"),
          email: "contract@test.com",
          countryCode: "91",
          flowType: "SMS",
          otpLength: 6,
          credentialVersion: 1,
          verifiedAt: new Date(),
          verificationStatus: "VERIFIED",
        },
      },
    });

    const mobile = "+919847099999";
    await Customer.create({
      _id: createId("customer"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerNumber: "C9099",
      name: "Contract User",
      mobile,
      status: "ACTIVE",
    });

    const requestBody = {
      tenantCode: "TESTCO",
      mobile,
      purpose: "LOGIN",
      deviceId: "flutter-device-1",
    };

    const requested = await request(app)
      .post("/api/v1/public/auth/otp/request")
      .set("x-idempotency-key", randomUUID())
      .send(requestBody)
      .expect(202);

    assert.equal(requested.body.success, true);
    for (const key of OTP_REQUEST_RESPONSE_KEYS) {
      assert.ok(key in requested.body.data, `missing request response key: ${key}`);
    }
    assert.match(requested.body.data.otpId, /^[0-9a-f-]{36}$/i);
    assert.equal(requested.body.data.channel, "SMS");

    const verifyBody = {
      ...requestBody,
      otp: "654321",
      otpId: requested.body.data.otpId,
      deviceInfo: {
        deviceId: "flutter-device-1",
        platform: "android",
        appVersion: "1.0.0",
      },
    };

    const verified = await request(app)
      .post("/api/v1/public/auth/otp/verify")
      .set("x-idempotency-key", randomUUID())
      .send(verifyBody)
      .expect(200);

    assert.equal(verified.body.success, true);
    for (const key of OTP_VERIFY_SESSION_KEYS) {
      assert.ok(key in verified.body.data, `missing verify response key: ${key}`);
    }
    assert.equal(verified.body.data.isNewCustomer, false);
    assert.ok(verified.body.data.customer?.id);
  } finally {
    globalThis.fetch = previousFetch;
  }
});


test("R20 public tenant resolution exposes verified OTP length and omits provider secrets", async () => {
  const { tenant } = await seedTenantUser({});
  await Tenant.updateOne({ _id: tenant._id }, { $set: { "integrationSecrets.messageCentral": { customerId: "review", keySealed: seal("review-only-key"), countryCode: "91", otpLength: 4, verifiedAt: new Date() } } });
  const resolved = await request(app).get("/api/v1/public/tenants/resolve").query({ tenantCode: tenant.code });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.data.tenants[0].otpLength, 4);
  assert.equal(resolved.body.data.tenants[0].integrationSecrets, undefined);
  assert.equal(JSON.stringify(resolved.body).includes("keySealed"), false);
});
