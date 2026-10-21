import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("digital-metal test harness is disabled in NODE_ENV=production subprocess", () => {
  const script = `
    import assert from "node:assert/strict";
    import { isEcommercePaymentsTestHarnessEnabled } from "./src/lib/ecommerce-test-harness.js";
    assert.equal(isEcommercePaymentsTestHarnessEnabled(), false);
    process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
    assert.equal(isEcommercePaymentsTestHarnessEnabled(), false);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production", ECOMMERCE_PAYMENTS_TEST_HARNESS: "false" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

const validProductionEnv = {
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
  MSG91_AUTH_KEY: "test-msg91-auth-key",
  MSG91_OTP_TEMPLATE_ID: "test-template-id",
  MSG91_SENDER_ID: "SWRNGR",
  FCM_SHARED_PROJECT_ENABLED: "true",
  FCM_PROJECT_ID: "test-firebase-project",
  FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
    client_email: "firebase-adminsdk@test-project.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\\nMIIB\\n-----END PRIVATE KEY-----\\n",
  }),
  S3_BUCKET: "prod-bucket",
  S3_ACCESS_KEY_ID: "prod-access-key",
  S3_SECRET_ACCESS_KEY: "prod-secret-key",
  CORS_ORIGINS: "https://app.example.com",
  PUBLIC_BASE_URL: "https://api.example.com",
  EXPORT_BASE_URL: "https://api.example.com",
  MALWARE_SCAN_URL: "https://scanner.example.com/scan",
};

test("digital-metal buy test-harness route handler throws not-found when harness off", () => {
  const script = `
    import assert from "node:assert/strict";
    import { completeTestHarnessBuyPayment } from "./src/services/digital-metals-buy-payment.service.js";
    let code;
    try {
      await completeTestHarnessBuyPayment({
        auth: { id: "cus_x", tenantId: "tnt_x" },
        params: { orderId: "dmbo_x" },
        body: { outcome: "COMPLETED" },
      });
    } catch (err) {
      code = err?.code;
    }
    assert.equal(code, "RESOURCE_NOT_FOUND");
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: {
      ...process.env,
      ...validProductionEnv,
      ECOMMERCE_PAYMENTS_TEST_HARNESS: "true",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
