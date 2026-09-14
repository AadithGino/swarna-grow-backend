import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import request from "supertest";
import { createApp } from "../src/app.js";

const app = createApp();

test("health and public app config use the standard success envelope", async () => {
  const health = await request(app).get("/health").expect(200);
  assert.equal(health.body.success, true);
  const config = await request(app).get("/api/v1/public/app-config").expect(200);
  assert.equal(config.body.success, true);
  assert.equal(config.body.data.android.forceUpdate, false);
});

test("invalid JSON returns a stable API error with a trace id", async () => {
  const response = await request(app).post("/api/v1/public/auth/otp/request").set("content-type", "application/json").send('{"broken"').expect(400);
  assert.equal(response.body.error.code, "INVALID_JSON");
  assert.ok(response.body.error.traceId);
});

test("literal pending and late-success payment routes are registered before payment id", async () => {
  for (const path of ["/api/v1/admin/payments/pending", "/api/v1/admin/payments/late-success"]) {
    const response = await request(app).get(path).expect(401);
    assert.equal(response.body.error.code, "UNAUTHENTICATED");
  }
});

test("removed tenant block endpoint is not present in platform router", async () => {
  const source = await fs.readFile(new URL("../src/routes/platform.routes.js", import.meta.url), "utf8");
  assert.equal(source.includes('/tenants/:tenantId/block'), false);
});

