import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("tenant settings profile PATCH rejects unknown fields", async () => {
  const { user, tenant } = await seedTenantUser({});
  const res = await request(app)
    .patch("/api/v1/admin/settings/profile")
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", randomUUID())
    .send({
      expectedVersion: tenant.version ?? 1,
      businessName: "Updated Jewellers",
      tenantId: "foreign_tenant",
    });
  assert.ok([400, 422].includes(res.status));
});

test("subscription upgrade request requires targetTier and rejects unknown fields", async () => {
  const { user } = await seedTenantUser({});
  const missing = await request(app)
    .post("/api/v1/admin/subscription/upgrade-request")
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", randomUUID())
    .send({ note: "Need more capacity" });
  assert.ok([400, 422].includes(missing.status));
  const unknown = await request(app)
    .post("/api/v1/admin/subscription/upgrade-request")
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", randomUUID())
    .send({ targetTier: "GROWTH", role: "TENANT_OWNER" });
  assert.ok([400, 422].includes(unknown.status));
});

test("report export alias rejects invalid reportKey", async () => {
  const { user } = await seedTenantUser({});
  const res = await request(app)
    .post("/api/v1/admin/reports/not-a-real-report/export")
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", randomUUID())
    .send({ format: "CSV" });
  assert.ok([400, 422].includes(res.status));
});

test("report export alias accepts normalized export type", async () => {
  const { user } = await seedTenantUser({});
  const res = await request(app)
    .post("/api/v1/admin/reports/collection/export")
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", randomUUID())
    .send({ format: "CSV", filters: { from: "2026-01-01", to: "2026-01-31" } });
  assert.equal(res.status, 202);
});

test("cash adjustment rejects unknown fields before write", async () => {
  const { user } = await seedTenantUser({});
  const res = await request(app)
    .post("/api/v1/admin/cash/adjustments")
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", randomUUID())
    .send({
      staffId: user._id,
      direction: "CREDIT",
      amountPaise: 1000,
      reason: "Test adjustment",
      extra: true,
    });
  assert.ok([400, 422].includes(res.status));
});
