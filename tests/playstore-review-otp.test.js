import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { Tenant } from "../src/models/index.js";
import { seal } from "../src/lib/crypto.js";
import {
  PLAYSTORE_REVIEW_OTP_CODE,
  playStoreReviewOtpEligible,
} from "../src/lib/playstore-review-otp.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

function installMessageCentralFetchMock(trackValidate) {
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
      trackValidate.called = true;
      return {
        ok: true,
        text: async () => JSON.stringify({
          message: "FAIL",
          data: { verificationStatus: "VERIFICATION_FAILED" },
        }),
      };
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };
}

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb({ force: true });
});
test.beforeEach(async () => {
  await resetTestDb();
});

test("playStoreReviewOtpEligible is false after go-live on non-demo tenants", () => {
  assert.equal(
    playStoreReviewOtpEligible({
      operations: { playStoreReviewOtpEnabled: true },
      goLiveAt: new Date(),
      isDemo: false,
    }),
    false,
  );
  assert.equal(
    playStoreReviewOtpEligible({
      operations: { playStoreReviewOtpEnabled: true },
      goLiveAt: new Date(),
      isDemo: true,
    }),
    true,
  );
  assert.equal(
    playStoreReviewOtpEligible({
      operations: { playStoreReviewOtpEnabled: true },
      goLiveAt: null,
      isDemo: false,
    }),
    true,
  );
  assert.equal(
    playStoreReviewOtpEligible(
      {
        operations: { playStoreReviewOtpEnabled: true },
        goLiveAt: new Date(),
        isDemo: false,
      },
      { PLAYSTORE_REVIEW_OTP_ALLOW_AFTER_GO_LIVE: true },
    ),
    true,
  );
});

test("Message Central verify accepts 123456 when playStoreReviewOtpEnabled (no MC validate call)", async () => {
  const trackValidate = { called: false };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = installMessageCentralFetchMock(trackValidate);

  try {
    const { tenant, branch } = await seedTenantUser({});
    await Tenant.updateOne({ _id: tenant._id }, {
      $set: {
        "operations.playStoreReviewOtpEnabled": true,
        "integrationSecrets.messageCentral": {
          provider: "MESSAGE_CENTRAL",
          customerId: "C-PLAY",
          keySealed: seal("mc-key-material"),
          email: "play@test.com",
          countryCode: "91",
          flowType: "SMS",
          otpLength: 6,
          credentialVersion: 1,
          verifiedAt: new Date(),
          verificationStatus: "VERIFIED",
        },
      },
    });

    const mobile = "+919847099001";
    await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile, name: "Play Review" });

    const reqBody = {
      tenantCode: tenant.code,
      mobile,
      purpose: "LOGIN",
      deviceId: "play-review",
    };
    const otpRes = await request(app)
      .post("/api/v1/public/auth/otp/request")
      .set("x-idempotency-key", randomUUID())
      .send(reqBody)
      .expect(202);

    const verifyRes = await request(app)
      .post("/api/v1/public/auth/otp/verify")
      .set("x-idempotency-key", randomUUID())
      .send({
        ...reqBody,
        otp: PLAYSTORE_REVIEW_OTP_CODE,
        otpId: otpRes.body.data.otpId,
        deviceInfo: { deviceId: "play-review", platform: "android", appVersion: "1.0.0" },
      });
    assert.equal(verifyRes.status, 200, JSON.stringify(verifyRes.body));

    assert.equal(trackValidate.called, false);
    assert.ok(verifyRes.body.data.accessToken);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("wrong OTP is rejected when playStoreReviewOtpEnabled is off", async () => {
  const trackValidate = { called: false };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = installMessageCentralFetchMock(trackValidate);

  try {
    const { tenant, branch } = await seedTenantUser({});
    await Tenant.updateOne({ _id: tenant._id }, {
      $set: {
        "operations.playStoreReviewOtpEnabled": false,
        "integrationSecrets.messageCentral": {
          provider: "MESSAGE_CENTRAL",
          customerId: "C-PLAY2",
          keySealed: seal("mc-key-material"),
          email: "play2@test.com",
          countryCode: "91",
          flowType: "SMS",
          otpLength: 6,
          credentialVersion: 1,
          verifiedAt: new Date(),
          verificationStatus: "VERIFIED",
        },
      },
    });

    const mobile = "+919847099002";
    await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile, name: "No Review OTP" });

    const reqBody = {
      tenantCode: tenant.code,
      mobile,
      purpose: "LOGIN",
      deviceId: "play-review",
    };
    const otpRes = await request(app)
      .post("/api/v1/public/auth/otp/request")
      .set("x-idempotency-key", randomUUID())
      .send(reqBody)
      .expect(202);

    await request(app)
      .post("/api/v1/public/auth/otp/verify")
      .set("x-idempotency-key", randomUUID())
      .send({
        ...reqBody,
        otp: "999999",
        otpId: otpRes.body.data.otpId,
        deviceInfo: { deviceId: "play-review", platform: "android", appVersion: "1.0.0" },
      })
      .expect(401);

    assert.equal(trackValidate.called, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("123456 rejected for go-live non-demo tenant even when playStoreReviewOtpEnabled is on", async () => {
  const trackValidate = { called: false };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = installMessageCentralFetchMock(trackValidate);

  try {
    const { tenant, branch } = await seedTenantUser({});
    await Tenant.updateOne({ _id: tenant._id }, {
      $set: {
        goLiveAt: new Date("2026-01-01"),
        isDemo: false,
        "operations.playStoreReviewOtpEnabled": true,
        "integrationSecrets.messageCentral": {
          provider: "MESSAGE_CENTRAL",
          customerId: "C-LIVE",
          keySealed: seal("mc-key-material"),
          email: "live@test.com",
          countryCode: "91",
          flowType: "SMS",
          otpLength: 6,
          credentialVersion: 1,
          verifiedAt: new Date(),
          verificationStatus: "VERIFIED",
        },
      },
    });

    const mobile = "+919847099003";
    await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile, name: "Live Tenant" });

    const reqBody = {
      tenantCode: tenant.code,
      mobile,
      purpose: "LOGIN",
      deviceId: "play-review",
    };
    const otpRes = await request(app)
      .post("/api/v1/public/auth/otp/request")
      .set("x-idempotency-key", randomUUID())
      .send(reqBody)
      .expect(202);

    await request(app)
      .post("/api/v1/public/auth/otp/verify")
      .set("x-idempotency-key", randomUUID())
      .send({
        ...reqBody,
        otp: PLAYSTORE_REVIEW_OTP_CODE,
        otpId: otpRes.body.data.otpId,
        deviceInfo: { deviceId: "play-review", platform: "android", appVersion: "1.0.0" },
      })
      .expect(401);

    assert.equal(trackValidate.called, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("123456 rejected when flag off (Message Central validate is used)", async () => {
  const trackValidate = { called: false };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/authentication/token")) {
      return { ok: true, text: async () => JSON.stringify({ status: 200, token: "mc-test-token" }) };
    }
    if (String(url).includes("/verification/v3/send")) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          responseCode: 200,
          message: "SUCCESS",
          data: { verificationId: "mc-verification-2" },
        }),
      };
    }
    if (String(url).includes("/validateOtp")) {
      trackValidate.called = true;
      return {
        ok: true,
        text: async () => JSON.stringify({
          message: "FAIL",
          data: { verificationStatus: "VERIFICATION_FAILED" },
        }),
      };
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const { tenant, branch } = await seedTenantUser({});
    await Tenant.updateOne({ _id: tenant._id }, {
      $set: {
        "operations.playStoreReviewOtpEnabled": false,
        "integrationSecrets.messageCentral": {
          provider: "MESSAGE_CENTRAL",
          customerId: "C-NOFLAG",
          keySealed: seal("mc-key-material"),
          email: "noflag@test.com",
          countryCode: "91",
          flowType: "SMS",
          otpLength: 6,
          credentialVersion: 1,
          verifiedAt: new Date(),
          verificationStatus: "VERIFIED",
        },
      },
    });

    const mobile = "+919847099004";
    await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile, name: "No Flag" });

    const reqBody = {
      tenantCode: tenant.code,
      mobile,
      purpose: "LOGIN",
      deviceId: "play-review",
    };
    const otpRes = await request(app)
      .post("/api/v1/public/auth/otp/request")
      .set("x-idempotency-key", randomUUID())
      .send(reqBody)
      .expect(202);

    await request(app)
      .post("/api/v1/public/auth/otp/verify")
      .set("x-idempotency-key", randomUUID())
      .send({
        ...reqBody,
        otp: PLAYSTORE_REVIEW_OTP_CODE,
        otpId: otpRes.body.data.otpId,
        deviceInfo: { deviceId: "play-review", platform: "android", appVersion: "1.0.0" },
      })
      .expect(401);

    assert.equal(trackValidate.called, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});