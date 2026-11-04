import test from "node:test";
import assert from "node:assert/strict";
import { assertOtpProviderReady } from "../src/integrations/otp.provider.js";
import {
  fetchMessageCentralAuthToken,
  sendMessageCentralOtp,
  validateMessageCentralOtp,
  toMessageCentralMobile,
} from "../src/integrations/message-central.client.js";
import { otpProvider } from "../src/integrations/otp.provider.js";
import { seal } from "../src/lib/crypto.js";
import { Tenant } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});

test("assertOtpProviderReady allows message_central without MSG91 env", () => {
  assert.doesNotThrow(() => assertOtpProviderReady({
    PROVIDER_MODE: "live",
    OTP_PROVIDER: "message_central",
  }));
});

test("toMessageCentralMobile normalizes Indian numbers", () => {
  assert.equal(toMessageCentralMobile("+919876543210"), "9876543210");
  assert.equal(toMessageCentralMobile("919876543210"), "9876543210");
});

test("Message Central client parses auth, send, and validate responses", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes("/authentication/token")) {
      return { ok: true, text: async () => JSON.stringify({ status: 200, token: "mc-token" }) };
    }
    if (url.includes("/verification/v3/send")) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          responseCode: 200,
          message: "SUCCESS",
          data: { verificationId: "vid-1" },
        }),
      };
    }
    if (url.includes("/validateOtp")) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          message: "SUCCESS",
          data: { verificationStatus: "VERIFICATION_COMPLETED" },
        }),
      };
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const creds = {
    customerId: "C-1",
    key: "base64-key",
    email: "ops@test.com",
    countryCode: "91",
  };
  const auth = await fetchMessageCentralAuthToken(creds, { fetch });
  assert.equal(auth.authToken, "mc-token");
  const sent = await sendMessageCentralOtp(
    { authToken: auth.authToken, mobile: "+919876543210", countryCode: "91" },
    { fetch },
  );
  assert.equal(sent.verificationId, "vid-1");
  const validated = await validateMessageCentralOtp(
    { authToken: auth.authToken, verificationId: "vid-1", code: "123456" },
    { fetch },
  );
  assert.equal(validated.ok, true);
  assert.ok(calls.length >= 3);
});

test("otpProvider uses Message Central when tenant integration is verified", async () => {
  const tenantId = createId("tenant");
  const messageCentralCredentials = {
    customerId: "C-TEST",
    key: "encrypted-key",
    email: "otp@test.com",
    countryCode: "91",
    flowType: "SMS",
    otpLength: 6,
    credentialVersion: 1,
    verifiedAt: new Date(),
  };
  await Tenant.create({
    _id: tenantId,
    code: `MC${String(Date.now()).slice(-6)}`,
    name: "MC OTP Tenant",
    displayName: "MC OTP",
    mobile: `+9199${String(Date.now()).slice(-8)}`,
    integrationSecrets: {
      messageCentral: {
        provider: "MESSAGE_CENTRAL",
        customerId: messageCentralCredentials.customerId,
        keySealed: seal(messageCentralCredentials.key),
        email: messageCentralCredentials.email,
        countryCode: "91",
        flowType: "SMS",
        otpLength: 6,
        credentialVersion: 1,
        verifiedAt: messageCentralCredentials.verifiedAt,
        verificationStatus: "VERIFIED",
      },
    },
  });

  let validateCalled = false;
  const fetch = async (url) => {
    if (url.includes("/authentication/token")) {
      return { ok: true, text: async () => JSON.stringify({ token: "tok" }) };
    }
    if (url.includes("/verification/v3/send")) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          message: "SUCCESS",
          data: { verificationId: "v-99" },
        }),
      };
    }
    if (url.includes("/validateOtp")) {
      validateCalled = true;
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: { verificationStatus: "VERIFICATION_COMPLETED" },
        }),
      };
    }
    throw new Error(url);
  };

  const mobile = `+9199${String(Date.now()).slice(-8)}`;
  const runtime = { PROVIDER_MODE: "live", OTP_PROVIDER: "message_central" };
  const deps = { env: runtime, fetch, messageCentralCredentials };
  const sent = await otpProvider.send(
    { tenantId, tenantCode: "MC", mobile, purpose: "LOGIN" },
    deps,
  );
  assert.ok(sent.otpId);
  assert.equal(await otpProvider.verify({
    tenantId,
    mobile,
    purpose: "LOGIN",
    otp: "654321",
    otpId: sent.otpId,
  }, deps), true);
  assert.equal(validateCalled, true);
});
