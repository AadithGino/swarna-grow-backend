import test from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import request from "supertest";
import { createApp } from "../src/app.js";
import { PlatformRole, UserStatus, UserType } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { AuditEvent, Session, SubscriptionPlan, User } from "../src/models/index.js";
import { bearerFor } from "./helpers/db.js";
import { platformRouteValidators } from "../src/validators/platform.validators.js";
import { resetTestDb, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function seedPlatformToken() {
  const user = await User.create({
    _id: createId("user"),
    type: UserType.PLATFORM_USER,
    role: PlatformRole.SUPER_ADMIN,
    name: "Platform Admin",
    passwordHash: await argon2.hash("9876", { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
    status: UserStatus.ACTIVE,
    permissions: ["*"],
  });
  const session = await Session.create({
    _id: createId("session"),
    userId: user._id,
    deviceId: "platform-device",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  user.$locals = { testSessionId: session._id };
  return bearerFor(user);
}

const routeMap = {
  "POST /subscription-plans": { method: "post", path: "/api/v1/platform/subscription-plans" },
  "PATCH /subscription-plans/:planId": { method: "patch", path: "/api/v1/platform/subscription-plans/pln_test123456" },
  "POST /subscription-plans/:planId/deprecate": { method: "post", path: "/api/v1/platform/subscription-plans/pln_test123456/deprecate" },
  "POST /tenants": { method: "post", path: "/api/v1/platform/tenants" },
  "PATCH /tenants/:tenantId": { method: "patch", path: "/api/v1/platform/tenants/tnt_test1234567890" },
  "PUT /app-config": { method: "put", path: "/api/v1/platform/app-config" },
};

test("platform mutation registry covers strict validators", () => {
  for (const key of Object.keys(routeMap)) {
    assert.ok(platformRouteValidators[key], `missing validator map for ${key}`);
    assert.ok(platformRouteValidators[key].body, `missing body schema for ${key}`);
  }
});

test("invalid platform create-tenant body returns 400 without audit", async () => {
  const token = await seedPlatformToken();
  const before = await AuditEvent.countDocuments({});
  const res = await request(app)
    .post("/api/v1/platform/tenants")
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", "platform-invalid-tenant")
    .send({ name: "Bad", unknownPrivilege: true, role: "SUPER_ADMIN" });
  assert.equal(res.status, 400);
  assert.equal(await AuditEvent.countDocuments({}), before);
});

test("valid platform plan patch reaches service", async () => {
  const token = await seedPlatformToken();
  const planId = createId("subscriptionPlan");
  await SubscriptionPlan.create({
    _id: planId,
    tier: "STARTER",
    name: "Starter",
    pricePaise: 99900,
    active: true,
    version: 1,
  });
  const res = await request(app)
    .patch(`/api/v1/platform/subscription-plans/${planId}`)
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", "platform-plan-patch")
    .send({ name: "Starter Updated", expectedVersion: 1 });
  assert.equal(res.status, 200);
  const audit = await AuditEvent.findOne({ action: "PLATFORM_PLAN_UPDATED", entityId: planId }).lean();
  assert.ok(audit);
});
