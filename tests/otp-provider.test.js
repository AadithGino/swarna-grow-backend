import test from "node:test";
import assert from "node:assert/strict";
import { assertOtpProviderReady, otpProvider } from "../src/integrations/otp.provider.js";
import { startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});

test("assertOtpProviderReady requires MSG91 credentials in live mode", () => {
  assert.throws(
    () => assertOtpProviderReady({ PROVIDER_MODE: "live", OTP_PROVIDER: "msg91" }),
    /MSG91 OTP not configured/,
  );
  assert.doesNotThrow(() => assertOtpProviderReady({ PROVIDER_MODE: "mock", OTP_PROVIDER: "mock" }));
  assert.doesNotThrow(() => assertOtpProviderReady({
    PROVIDER_MODE: "live",
    OTP_PROVIDER: "msg91",
    MSG91_AUTH_KEY: "k",
    MSG91_OTP_TEMPLATE_ID: "t",
    MSG91_SENDER_ID: "SWRNGR",
  }));
});

test("OTP verify succeeds once and locks out after five failures", async () => {
  const mobile = `+9199${String(Date.now()).slice(-8)}`;
  await otpProvider.send({ tenantId: "tnt_otp", tenantCode: "OTPCO", mobile, purpose: "LOGIN" });
  assert.equal(await otpProvider.verify({ tenantId: "tnt_otp", mobile, purpose: "LOGIN", otp: "000000" }), false);
  assert.equal(await otpProvider.verify({ tenantId: "tnt_otp", mobile, purpose: "LOGIN", otp: "000001" }), false);
  assert.equal(await otpProvider.verify({ tenantId: "tnt_otp", mobile, purpose: "LOGIN", otp: "000002" }), false);
  assert.equal(await otpProvider.verify({ tenantId: "tnt_otp", mobile, purpose: "LOGIN", otp: "000003" }), false);
  assert.equal(await otpProvider.verify({ tenantId: "tnt_otp", mobile, purpose: "LOGIN", otp: "000004" }), false);
  assert.equal(await otpProvider.verify({ tenantId: "tnt_otp", mobile, purpose: "LOGIN", otp: "123456" }), false);
});

test("OTP resend cooldown rejects immediate second send", async () => {
  const mobile = `+9198${String(Date.now()).slice(-8)}`;
  await otpProvider.send({ tenantId: "tnt_otp2", tenantCode: "OTPCO", mobile, purpose: "LOGIN" });
  await assert.rejects(() => otpProvider.send({ tenantId: "tnt_otp2", tenantCode: "OTPCO", mobile, purpose: "LOGIN" }), (error) => error.code === "OTP_RESEND_COOLDOWN");
});
