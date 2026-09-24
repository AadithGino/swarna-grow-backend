import test from "node:test";
import assert from "node:assert/strict";
import { parseEnv } from "../src/config/env.js";
import { AppError } from "../src/lib/app-error.js";
import {
  MSG91_FLOW_URL,
  sendMsg91Otp,
  toMsg91Mobile,
} from "../src/integrations/msg91.client.js";
import { assertOtpProviderReady, otpProvider } from "../src/integrations/otp.provider.js";
import { validProductionEnv } from "./phase6-production-config.test.js";
import { startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});

const msg91Ready = {
  PROVIDER_MODE: "live",
  OTP_PROVIDER: "msg91",
  MSG91_AUTH_KEY: "auth-key",
  MSG91_OTP_TEMPLATE_ID: "tmpl-1",
  MSG91_SENDER_ID: "SWRNGR",
  MSG91_OTP_VAR: "otp",
  MSG91_DEFAULT_COUNTRY_CODE: "91",
  MSG91_SMS_TIMEOUT_MS: 8000,
  OTP_TTL_SECONDS: 300,
};

test("assertOtpProviderReady accepts live msg91 when configured", () => {
  assert.doesNotThrow(() => assertOtpProviderReady(msg91Ready));
});

test("assertOtpProviderReady throws when any MSG91 credential is missing", () => {
  for (const key of ["MSG91_AUTH_KEY", "MSG91_OTP_TEMPLATE_ID", "MSG91_SENDER_ID"]) {
    const source = { ...msg91Ready, [key]: "" };
    assert.throws(() => assertOtpProviderReady(source), /MSG91 OTP not configured/);
  }
});

test("production env validation lists missing MSG91 keys when OTP_PROVIDER is msg91", () => {
  const result = parseEnv({
    ...validProductionEnv,
    MSG91_AUTH_KEY: undefined,
    MSG91_OTP_TEMPLATE_ID: "",
    MSG91_SENDER_ID: "   ",
  });
  assert.equal(result.success, false);
  const message = result.error.issues.map((issue) => issue.message).join(" ");
  assert.match(message, /MSG91_AUTH_KEY/);
  assert.match(message, /MSG91_OTP_TEMPLATE_ID/);
  assert.match(message, /MSG91_SENDER_ID/);
  const paths = result.error.issues.flatMap((issue) => issue.path ?? []);
  assert.ok(paths.includes("MSG91_AUTH_KEY"));
  assert.ok(paths.includes("MSG91_OTP_TEMPLATE_ID"));
  assert.ok(paths.includes("MSG91_SENDER_ID"));
});

test("toMsg91Mobile normalizes and rejects short numbers", () => {
  assert.equal(toMsg91Mobile("+91 98765 43210"), "919876543210");
  assert.equal(toMsg91Mobile("9876543210"), "919876543210");
  assert.equal(toMsg91Mobile("919876543210"), "919876543210");
  assert.throws(() => toMsg91Mobile("98765"), /Invalid mobile/);
});

test("sendMsg91Otp posts Flow payload and returns request_id", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ type: "success", request_id: "req_abc" }),
    };
  };
  const result = await sendMsg91Otp(
    { mobile: "+91 98765 43210", otp: "654321" },
    { fetch: fetchImpl, env: msg91Ready },
  );
  assert.equal(result.providerMessageId, "req_abc");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, MSG91_FLOW_URL);
  assert.equal(calls[0].init.headers.authkey, "auth-key");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, {
    template_id: "tmpl-1",
    sender: "SWRNGR",
    recipients: [{ mobiles: "919876543210", otp: "654321" }],
  });
});

test("sendMsg91Otp throws on non-2xx and type error", async () => {
  await assert.rejects(
    () => sendMsg91Otp(
      { mobile: "9876543210", otp: "111111" },
      {
        env: msg91Ready,
        fetch: async () => ({
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ message: "upstream" }),
        }),
      },
    ),
    /MSG91 delivery failed/,
  );
  await assert.rejects(
    () => sendMsg91Otp(
      { mobile: "9876543210", otp: "111111" },
      {
        env: msg91Ready,
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ type: "error", message: "bad template" }),
        }),
      },
    ),
    /bad template/,
  );
});

test("otpProvider.send with msg91 returns SMS DTO on delivery success", async () => {
  const mobile = `+9197${String(Date.now()).slice(-8)}`;
  const dto = await otpProvider.send(
    { tenantId: "tnt_msg91", tenantCode: "MSG91", mobile, purpose: "LOGIN" },
    {
      env: msg91Ready,
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ type: "success", request_id: "req_ok" }),
      }),
    },
  );
  assert.equal(dto.channel, "SMS");
  assert.ok(dto.otpId);
  assert.equal(dto.attemptsAllowed, 5);
  assert.equal(dto.resendAvailableInSeconds, 30);
  assert.ok(dto.maskedMobile);
});

test("otpProvider.send deletes OTP on MSG91 failure and throws OTP_DELIVERY_FAILED", async () => {
  const mobile = `+9196${String(Date.now()).slice(-8)}`;
  await assert.rejects(
    () => otpProvider.send(
      { tenantId: "tnt_msg91f", tenantCode: "MSG91", mobile, purpose: "LOGIN" },
      {
        env: msg91Ready,
        fetch: async () => ({
          ok: false,
          status: 502,
          text: async () => JSON.stringify({ message: "down" }),
        }),
      },
    ),
    (error) => error instanceof AppError
      && error.code === "OTP_DELIVERY_FAILED"
      && error.statusCode === 502,
  );
  // Record deleted → immediate resend must not hit cooldown with a stale hash.
  const dto = await otpProvider.send(
    { tenantId: "tnt_msg91f", tenantCode: "MSG91", mobile, purpose: "LOGIN" },
    {
      env: msg91Ready,
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ type: "success", request_id: "req_retry" }),
      }),
    },
  );
  assert.equal(dto.channel, "SMS");
  assert.ok(dto.otpId);
});
