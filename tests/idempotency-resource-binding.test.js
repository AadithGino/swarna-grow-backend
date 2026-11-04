import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIdempotencyEndpoint,
  idempotencyEndpointsCompatible,
  normalizeIdempotencyRoutePath,
} from "../src/lib/idempotency-endpoint.js";
import { beginIdempotency, hashIdempotencyBody } from "../src/services/idempotency.service.js";
import { IdempotencyRecord } from "../src/models/index.js";
import { resetTestDb, startTestDb, stopTestDb } from "./helpers/db.js";
import { createId } from "../src/lib/ids.js";

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

test("idempotency endpoint binds route template and resource params", () => {
  const reqA = {
    method: "POST",
    baseUrl: "/api/v1/admin",
    route: { path: "/ecommerce/orders/:orderId/ship" },
    params: { orderId: "eo_a" },
    query: {},
  };
  const reqB = { ...reqA, params: { orderId: "eo_b" } };
  const a = buildIdempotencyEndpoint(reqA);
  const b = buildIdempotencyEndpoint(reqB);
  assert.notEqual(a, b);
  assert.match(a, /orderId:eo_a/);
});

test("idempotency endpoint includes mutation-relevant query keys", () => {
  const req = {
    method: "POST",
    baseUrl: "",
    route: { path: "/refunds/:refundId/manual" },
    params: { refundId: "rf_1" },
    query: { refundId: "rf_1", noise: "ignored" },
  };
  const endpoint = buildIdempotencyEndpoint(req);
  assert.match(endpoint, /refundId=rf_1/);
});

test("legacy endpoint without mount matches resource-bound route template", () => {
  const legacy = "POST /schemes/enrol";
  const current = "POST /api/v1/app/schemes/enrol";
  assert.equal(normalizeIdempotencyRoutePath(legacy), normalizeIdempotencyRoutePath(current));
  assert.equal(idempotencyEndpointsCompatible(legacy, current), true);
});

test("different resource ids on the same route are not compatible", () => {
  const a = "POST /api/v1/admin/ecommerce/orders/:orderId/ship{orderId:eo_a}";
  const b = "POST /api/v1/admin/ecommerce/orders/:orderId/ship{orderId:eo_b}";
  assert.equal(idempotencyEndpointsCompatible(a, b), false);
});

test("legacy PAYMENT_INIT_FAILED record is repaired under new endpoint identity", async () => {
  const tenantId = createId("tenant");
  const actorId = createId("customer");
  const key = "idem-legacy-repair";
  const body = { planId: "plan_1" };
  const legacyEndpoint = "POST /schemes/enrol";
  const currentEndpoint = "POST /api/v1/app/schemes/enrol";
  await IdempotencyRecord.create({
    tenantId,
    actorId,
    endpoint: legacyEndpoint,
    key,
    bodyHash: hashIdempotencyBody(body),
    state: "COMPLETED",
    responseStatus: 422,
    responseBody: { success: false, error: { code: "PAYMENT_INIT_FAILED", message: "old" } },
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const started = await beginIdempotency({ tenantId, actorId, endpoint: currentEndpoint, key, body });
  assert.equal(started.replay, false);
  assert.equal(started.record.state, "PROCESSING");
  assert.equal(await IdempotencyRecord.countDocuments({ tenantId, key, responseStatus: 422 }), 0);
});

test("same key on another resource rejects without replaying", async () => {
  const tenantId = createId("tenant");
  const actorId = createId("user");
  const key = "idem-cross-resource";
  const body = { note: "same" };
  const endpointA = "POST /api/v1/admin/ecommerce/orders/:orderId/ship{orderId:eo_a}";
  const endpointB = "POST /api/v1/admin/ecommerce/orders/:orderId/ship{orderId:eo_b}";
  await beginIdempotency({ tenantId, actorId, endpoint: endpointA, key, body });
  await assert.rejects(
    () => beginIdempotency({ tenantId, actorId, endpoint: endpointB, key, body }),
    (error) => error.code === "IDEMPOTENCY_KEY_REUSED",
  );
});
