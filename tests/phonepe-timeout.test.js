import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../src/config/env.js";
import { applyPhonePeClientTimeout } from "../src/integrations/phonepe.provider.js";

test("applyPhonePeClientTimeout sets per-request timeout on SDK http client", () => {
  const httpClient = {
    defaults: {},
    interceptors: {
      request: {
        use(fn) {
          httpClient._hook = fn;
        },
      },
    },
  };
  applyPhonePeClientTimeout({ httpClient });
  const config = {};
  httpClient._hook(config);
  assert.equal(config.timeout, env.PHONEPE_REQUEST_TIMEOUT_MS ?? 20_000);
  assert.equal(httpClient.defaults.timeout, env.PHONEPE_REQUEST_TIMEOUT_MS ?? 20_000);
});

test("applyPhonePeClientTimeout hook aborts within configured timeout", async () => {
  const timeoutMs = 120;
  const httpClient = {
    defaults: { timeout: timeoutMs },
    interceptors: {
      request: {
        use(fn) {
          httpClient._hook = fn;
        },
      },
    },
    async get(_url, config = {}) {
      const merged = httpClient._hook({ ...config, timeout: timeoutMs });
      const bound = merged.timeout ?? timeoutMs;
      return new Promise((_resolve, reject) => {
        setTimeout(() => {
          const error = new Error(`timeout of ${bound}ms exceeded`);
          error.code = "ECONNABORTED";
          reject(error);
        }, bound);
      });
    },
  };
  applyPhonePeClientTimeout({ httpClient });
  const started = Date.now();
  await assert.rejects(() => httpClient.get("/stall"), (error) => error.code === "ECONNABORTED");
  assert.ok(Date.now() - started < timeoutMs + 250);
});
