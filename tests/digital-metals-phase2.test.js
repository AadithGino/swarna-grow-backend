import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { PlanTier } from "../src/constants/enums.js";
import { Permission } from "../src/constants/permissions.js";
import {
  metalSubtotalPaiseFromQuantity,
  maxQuantityUgForBuyBudget,
  UG_PER_G,
} from "../src/lib/digital-metals-quote-engine.js";
import { Tenant } from "../src/models/index.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { makeTenantQuoteReady } from "./helpers/digital-metals-live-ready.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function enablePlan(tenantId, { tax = false, terms = false } = {}) {
  await Tenant.updateOne(
    { _id: tenantId },
    {
      $set: {
        "subscription.planFeaturesSnapshot.digitalMetals": true,
        "subscription.tier": PlanTier.GROWTH,
        "operations.digitalMetalsEnabled": true,
        ...(tax ? { "operations.digitalMetalsTaxProfileApprovedAt": new Date() } : {}),
        ...(terms ? { "operations.digitalMetalsTermsVersion": "2026-10-01" } : {}),
      },
    },
  );
}

test("quote engine A1/A3 numerical parity", () => {
  const sub = metalSubtotalPaiseFromQuantity(UG_PER_G, 600_000);
  assert.equal(sub, 600_000);
  const budget = maxQuantityUgForBuyBudget(606_000, 600_000, { type: "PERCENT", percent: 1, minPaise: 5000 }, []);
  assert.equal(budget.totalPayablePaise, 606_000);
});

test("settings patch requires settings.write permission", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const token = bearerFor(user, [Permission.DIGITAL_METALS_READ]);
  const res = await request(app)
    .patch("/api/v1/admin/digital-metals/settings")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: 1, metal: "GOLD", finenessPpm: 999000 });
  assert.equal(res.status, 403);
});

test("quote preview rejected without tax profile and terms", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const token = bearerFor(user);
  const res = await request(app)
    .post("/api/v1/admin/digital-metals/quotes/preview")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      side: "BUY",
      metal: "GOLD",
      finenessPpm: 999000,
      inputMode: "BUDGET_INR",
      budgetPaise: 600_000,
    });
  assert.equal(res.status, 422);
});

test("publish rate and preview buy quote when live-ready", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const token = bearerFor(user);
  await makeTenantQuoteReady(app, tenant._id, token);
  const quote = await request(app)
    .post("/api/v1/admin/digital-metals/quotes/preview")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      side: "BUY",
      metal: "GOLD",
      finenessPpm: 999000,
      inputMode: "BUDGET_INR",
      budgetPaise: 600_000,
    });
  assert.equal(quote.status, 201);
  assert.equal(quote.body.data.metalQuantityUg, String(UG_PER_G));
});

test("operations patch cannot self-certify tax or terms", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const token = bearerFor(user);
  const ops = await request(app)
    .get("/api/v1/admin/settings/operations")
    .set("Authorization", `Bearer ${token}`);
  const res = await request(app)
    .patch("/api/v1/admin/settings/operations")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      expectedVersion: ops.body.data.audit.version,
      digitalMetalsTermsVersion: "fake-terms",
      digitalMetalsTaxProfileApprovedAt: new Date().toISOString(),
    });
  assert.equal(res.status, 400);
  const row = await Tenant.findById(tenant._id).lean();
  assert.equal(row.operations.digitalMetalsTermsVersion, "");
  assert.equal(row.operations.digitalMetalsTaxProfileApprovedAt, undefined);
});

test("settings version conflict returns VERSION_CONFLICT envelope", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const token = bearerFor(user);
  await request(app)
    .patch("/api/v1/admin/digital-metals/settings")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: 1, metal: "GOLD", finenessPpm: 999000 });
  const res = await request(app)
    .patch("/api/v1/admin/digital-metals/settings")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: 2, metal: "GOLD", finenessPpm: 999000 });
  assert.equal(res.status, 409);
  assert.equal(res.body.error?.code, "VERSION_CONFLICT");
});

test("exposure cap patch is rejected", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const token = bearerFor(user);
  const res = await request(app)
    .patch("/api/v1/admin/digital-metals/settings")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      expectedVersion: 1,
      metal: "GOLD",
      finenessPpm: 999000,
      exposureCapPaise: 100,
    });
  assert.ok(res.status === 400 || res.status === 422);
});

test("rate schedule timezone round trip via effectiveAtLocal", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const token = bearerFor(user);
  const local = "2026-12-01T10:30";
  const published = await request(app)
    .post("/api/v1/admin/digital-metals/rates/publish")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      metal: "GOLD",
      finenessPpm: 999000,
      customerBuyRatePerGramPaise: 600_000,
      customerSellRatePerGramPaise: 590_000,
      effectiveAtLocal: local,
    });
  assert.equal(published.status, 201);
  const parsed = new Date(published.body.data.effectiveAt).getTime();
  assert.equal(parsed, new Date(local).getTime());
});

test("capability lists per-asset readiness", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const token = bearerFor(user);
  const cap = await request(app)
    .get("/api/v1/admin/digital-metals/capability")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(cap.status, 200);
  assert.ok(Array.isArray(cap.body.data.assets));
  assert.ok(cap.body.data.assets.some((a) => a.metal === "GOLD"));
});

test("tenant pause and resume via operations API", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const token = bearerFor(user);
  const paused = await request(app)
    .post("/api/v1/admin/digital-metals/operations/pause")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ pause: true, reason: "Maintenance window" });
  assert.equal(paused.status, 200);
  const cap = await request(app)
    .get("/api/v1/admin/digital-metals/capability")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(cap.body.data.pause?.tenantPaused, true);
  assert.match(cap.body.data.pause?.tenantPauseReason ?? "", /Maintenance/);
  await request(app)
    .post("/api/v1/admin/digital-metals/operations/pause")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ pause: false });
});
