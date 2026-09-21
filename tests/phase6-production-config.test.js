import test from "node:test";
import assert from "node:assert/strict";
import { parseEnv } from "../src/config/env.js";

const validFcmServiceAccount = JSON.stringify({
  client_email: "firebase-adminsdk@test-project.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
});

export const validProductionEnv = {
  NODE_ENV: "production",
  JWT_ACCESS_SECRET: "production-access-secret-value-32chars-min",
  JWT_REFRESH_SECRET: "production-refresh-secret-value-32chars-x",
  INTEGRATION_ENCRYPTION_KEY: "production-integration-key-32chars-min",
  SEED_PLATFORM_PASSWORD: "9876",
  REDIS_REQUIRED: "true",
  RATE_LIMIT_ENABLED: "true",
  PROVIDER_MODE: "live",
  PHONEPE_ENV: "PRODUCTION",
  OTP_PROVIDER: "msg91",
  FCM_SHARED_PROJECT_ENABLED: "true",
  FCM_PROJECT_ID: "test-firebase-project",
  FCM_SERVICE_ACCOUNT_JSON: validFcmServiceAccount,
  S3_BUCKET: "prod-bucket",
  S3_ACCESS_KEY_ID: "prod-access-key",
  S3_SECRET_ACCESS_KEY: "prod-secret-key",
  CORS_ORIGINS: "https://app.example.com",
  PUBLIC_BASE_URL: "https://api.example.com",
  EXPORT_BASE_URL: "https://api.example.com",
  MALWARE_SCAN_URL: "https://scanner.example.com/scan",
};

test("production parse fails when OTP_PROVIDER is mock", () => {
  const result = parseEnv({ ...validProductionEnv, OTP_PROVIDER: "mock" });
  assert.equal(result.success, false);
  assert.match(
    result.error.issues.map((issue) => issue.message).join(" "),
    /OTP_PROVIDER/,
  );
});

test("production parse succeeds when OTP_PROVIDER is msg91", () => {
  const result = parseEnv(validProductionEnv);
  assert.equal(result.success, true);
});
