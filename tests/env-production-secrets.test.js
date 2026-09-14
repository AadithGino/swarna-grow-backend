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

test("production parse succeeds with unique non-default secrets", () => {
  const result = parseEnv({
    NODE_ENV: "production",
    JWT_ACCESS_SECRET: "production-access-secret-value-32chars-min",
    JWT_REFRESH_SECRET: "production-refresh-secret-value-32chars-x",
    INTEGRATION_ENCRYPTION_KEY: "production-integration-key-32chars-min",
    SEED_PLATFORM_PASSWORD: "ProductionSeed!Pass99",
  });
  assert.equal(result.success, true);
});
