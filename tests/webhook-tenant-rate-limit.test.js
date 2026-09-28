import test from "node:test";
import assert from "node:assert/strict";
import { tenantWebhookKey } from "../src/middlewares/webhook.middleware.js";

test("webhook per-tenant rate limit keys differ by tenant id on route", () => {
  const keyGen = tenantWebhookKey;
  const base = { ip: "203.0.113.10", path: "/phonepe/tnt_a" };
  const a = keyGen({ ...base, params: { tenantId: "tnt_a" } });
  const b = keyGen({ ...base, params: { tenantId: "tnt_b" }, path: "/phonepe/tnt_b" });
  assert.notEqual(a, b);
  assert.match(a, /tnt_a/);
  assert.match(b, /tnt_b/);
});
