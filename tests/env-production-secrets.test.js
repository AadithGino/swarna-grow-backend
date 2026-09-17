import test from "node:test";
import assert from "node:assert/strict";
import { parseEnv, SECRET_DEFAULTS } from "../src/config/env.js";

test("production parse fails when secrets are missing and names all four variables", () => {
  const result = parseEnv({ NODE_ENV: "production" });
  assert.equal(result.success, false);
  const message = result.error.issues.map((issue) => issue.message).join(" ");
  for (const key of Object.keys(SECRET_DEFAULTS)) {
    assert.match(message, new RegExp(key));
  }
});

test("production parse fails when secrets equal published defaults", () => {
  const result = parseEnv({ NODE_ENV: "production", ...SECRET_DEFAULTS });
  assert.equal(result.success, false);
  const message = result.error.issues.map((issue) => issue.message).join(" ");
  assert.match(message, /JWT_ACCESS_SECRET/);
  assert.match(message, /SEED_PLATFORM_PASSWORD/);
});

test("production parse fails when REDIS_REQUIRED is false or unset", () => {
  const result = parseEnv({
    NODE_ENV: "production",
    JWT_ACCESS_SECRET: "production-access-secret-value-32chars-min",
    JWT_REFRESH_SECRET: "production-refresh-secret-value-32chars-x",
    INTEGRATION_ENCRYPTION_KEY: "production-integration-key-32chars-min",
    SEED_PLATFORM_PASSWORD: "ProductionSeed!Pass99",
    REDIS_REQUIRED: "false",
  });
  assert.equal(result.success, false);
  const message = result.error.issues.map((issue) => issue.message).join(" ");
  assert.match(message, /REDIS_REQUIRED/);
});

const validProductionEnv = {
  NODE_ENV: "production",
  JWT_ACCESS_SECRET: "production-access-secret-value-32chars-min",
  JWT_REFRESH_SECRET: "production-refresh-secret-value-32chars-x",
  INTEGRATION_ENCRYPTION_KEY: "production-integration-key-32chars-min",
  SEED_PLATFORM_PASSWORD: "ProductionSeed!Pass99",
  REDIS_REQUIRED: "true",
  PROVIDER_MODE: "live",
  PHONEPE_BASE_URL: "https://api.phonepe.com/apis/hermes",
  S3_BUCKET: "prod-bucket",
  S3_ACCESS_KEY_ID: "prod-access-key",
  S3_SECRET_ACCESS_KEY: "prod-secret-key",
  CORS_ORIGINS: "https://app.example.com",
};

test("production parse succeeds with unique non-default secrets", () => {
  const result = parseEnv(validProductionEnv);
  assert.equal(result.success, true);
});

test("production parse fails when PROVIDER_MODE is mock", () => {
  const result = parseEnv({ ...validProductionEnv, PROVIDER_MODE: "mock" });
  assert.equal(result.success, false);
  assert.match(result.error.issues.map((issue) => issue.message).join(" "), /PROVIDER_MODE/);
});

test("production parse fails when S3 settings are empty", () => {
  const result = parseEnv({ ...validProductionEnv, S3_BUCKET: "" });
  assert.equal(result.success, false);
  assert.match(result.error.issues.map((issue) => issue.message).join(" "), /S3_BUCKET/);
});

test("production parse fails when CORS_ORIGINS uses localhost defaults", () => {
  const result = parseEnv({
    ...validProductionEnv,
    CORS_ORIGINS: "http://localhost:3000,http://localhost:5173,http://localhost:5174",
  });
  assert.equal(result.success, false);
  assert.match(result.error.issues.map((issue) => issue.message).join(" "), /CORS_ORIGINS/);
});
