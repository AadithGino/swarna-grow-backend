import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { PlanTier, TenantRole } from "../src/constants/enums.js";
import { Permission } from "../src/constants/permissions.js";
import { buildDigitalMetalsCapability } from "../src/lib/digital-metals-capability.js";
import { DigitalMetalAccessMarker, Session, Tenant } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import {
  bearerFor,
  resetTestDb,
  seedCustomer,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";
import { signAccessToken } from "../src/services/token.service.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function customerAccessToken({ tenant, branch, customer }) {
  const session = await Session.create({
    _id: createId("session"),
    customerId: customer._id,
    tenantId: tenant._id,
    deviceId: "customer-device",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "android",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return signAccessToken({
    id: customer._id,
    type: "CUSTOMER",
    tenantId: tenant._id,
    branchId: branch._id,
    role: "CUSTOMER",
    permissions: [],
    deviceId: "customer-device",
    securityVersion: 0,
    sessionId: session._id,
  });
}

async function enableDigitalMetalsPlan(tenantId, { enabled = true, tax = false, terms = false } = {}) {
  await Tenant.updateOne(
    { _id: tenantId },
    {
      $set: {
        "subscription.planFeaturesSnapshot.digitalMetals": true,
        "subscription.tier": PlanTier.GROWTH,
        "operations.digitalMetalsEnabled": enabled,
        ...(tax ? { "operations.digitalMetalsTaxProfileApprovedAt": new Date() } : {}),
        ...(terms ? { "operations.digitalMetalsTermsVersion": "2026-10-01" } : {}),
      },
    },
  );
}

test("capability blocks new trading without tax/terms (U1/U2) but allows legacy holdings view", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableDigitalMetalsPlan(tenant._id);
  const token = bearerFor(user);
  const res = await request(app)
    .get("/api/v1/admin/digital-metals/capability")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.canViewHoldings, true);
  assert.equal(res.body.data.canPlaceNewBuy, false);
  assert.ok(res.body.data.blockers.some((b) => b.code === "TAX_CONFIG_INCOMPLETE"));
});

test("plan downgrade with legacy marker preserves customer holdings access", () => {
  const tenant = {
    operations: { digitalMetalsEnabled: true },
    subscription: { planFeaturesSnapshot: { digitalMetals: false } },
  };
  const cap = buildDigitalMetalsCapability(tenant, { hasHoldings: true });
  assert.equal(cap.canViewHoldings, true);
  assert.equal(cap.canPlaceNewBuy, false);
});

test("admin capability denied without read permission", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableDigitalMetalsPlan(tenant._id);
  const token = bearerFor(user, [Permission.CUSTOMER_READ]);
  const res = await request(app)
    .get("/api/v1/admin/digital-metals/capability")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(res.status, 403);
});

test("admin capability succeeds when entitled and enabled", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableDigitalMetalsPlan(tenant._id);
  const token = bearerFor(user);
  const res = await request(app)
    .get("/api/v1/admin/digital-metals/capability")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.canViewHoldings, true);
  assert.equal(res.body.data.canPlaceNewBuy, false);
});

test("cross-tenant admin token cannot read another tenant capability", async () => {
  const a = await seedTenantUser({ tenantCode: "DM_A" });
  const b = await seedTenantUser({ tenantCode: "DM_B" });
  await enableDigitalMetalsPlan(a.tenant._id);
  await enableDigitalMetalsPlan(b.tenant._id);
  const tokenA = bearerFor(a.user);
  const res = await request(app)
    .get("/api/v1/admin/digital-metals/capability")
    .set("Authorization", `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  assert.notEqual(res.body.data.scope?.branchId, b.branch._id);
});

test("customer capability reflects legacy settlement access when plan paused", async () => {
  const { tenant, branch } = await seedTenantUser({});
  await enableDigitalMetalsPlan(tenant._id);
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "operations.digitalMetalsPlatformPaused": true, "operations.digitalMetalsPlatformPauseReason": "Risk review" } },
  );
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await DigitalMetalAccessMarker.create({
    _id: createId("dmam"),
    tenantId: tenant._id,
    customerId: customer._id,
    kinds: ["SETTLEMENT"],
  });
  const token = await customerAccessToken({ tenant, branch, customer });
  const res = await request(app)
    .get("/api/v1/app/digital-metals/capability")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.canPlaceNewSell, false);
  assert.equal(res.body.data.canAccessSettlement, true);
});

test("enabling module without plan returns FEATURE_NOT_ENTITLED on operations patch", async () => {
  const { user } = await seedTenantUser({});
  const token = bearerFor(user);
  const ops = await request(app)
    .get("/api/v1/admin/settings/operations")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(ops.status, 200);
  const expectedVersion = Number(ops.body.data?.audit?.version ?? 1);
  const res = await request(app)
    .patch("/api/v1/admin/settings/operations")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      expectedVersion,
      digitalMetalsEnabled: true,
    });
  assert.equal(res.status, 403);
  assert.equal(res.body.error?.code, "FEATURE_NOT_ENTITLED");
});

test("branch manager receives branch scope in capability DTO", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.BRANCH_MANAGER });
  await enableDigitalMetalsPlan(tenant._id);
  const token = bearerFor(user);
  const res = await request(app)
    .get("/api/v1/admin/digital-metals/capability")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.scope?.roleScope, "BRANCH");
  assert.equal(res.body.data.scope?.branchId, branch._id);
});
