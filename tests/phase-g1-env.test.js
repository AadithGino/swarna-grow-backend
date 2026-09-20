import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseEnv } from "../src/config/env.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("production parse rejects out-of-range G1 retry settings", () => {
  const base = {
    NODE_ENV: "production",
    JWT_ACCESS_SECRET: "prod-access-secret-32chars-minimum!!",
    JWT_REFRESH_SECRET: "prod-refresh-secret-32chars-minimum!",
    INTEGRATION_ENCRYPTION_KEY: "prod-integration-key-32chars!!",
    REDIS_REQUIRED: "true",
    RATE_LIMIT_ENABLED: "true",
    PROVIDER_MODE: "live",
    PHONEPE_ENV: "PRODUCTION",
    S3_BUCKET: "bucket",
    S3_ACCESS_KEY_ID: "key",
    S3_SECRET_ACCESS_KEY: "secret",
    MALWARE_SCAN_URL: "https://scan.example.com/check",
    CORS_ORIGINS: "https://app.example.com",
    PUBLIC_BASE_URL: "https://api.example.com",
    EXPORT_BASE_URL: "https://api.example.com",
    SCHEDULER_JOB_ATTEMPTS: "99",
  };
  const parsed = parseEnv(base);
  assert.equal(parsed.success, false);
});

test(".env.example lists Phase G1 cursor and retry keys without secrets", () => {
  const example = readFileSync(path.join(root, ".env.example"), "utf8");
  for (const key of [
    "MAINTENANCE_CURSOR_TTL_SEC",
    "MAINTENANCE_SCAN_LEASE_MS",
    "SCHEDULER_JOB_ATTEMPTS",
    "SCHEDULER_JOB_BACKOFF_MS",
    "PAYMENTS_JOB_ATTEMPTS",
    "PAYMENTS_JOB_BACKOFF_MS",
    "MAINTENANCE_JOB_ATTEMPTS",
    "MAINTENANCE_JOB_BACKOFF_MS",
    "SCHEME_MAINTENANCE_BATCH_SIZE",
    "PAYMENT_EXPIRY_BATCH_SIZE",
  ]) {
    assert.match(example, new RegExp(`^${key}=`, "m"), key);
  }
  assert.doesNotMatch(example, /BEGIN PRIVATE KEY/);
  assert.doesNotMatch(example, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./);
});
