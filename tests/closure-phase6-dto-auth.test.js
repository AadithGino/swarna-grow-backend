import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { tenantPortalCapabilitiesDto } from "../src/lib/customer-app-dto.js";
import { Session, User } from "../src/models/index.js";
import { signAccessToken } from "../src/services/token.service.js";
import { TenantRole, UserType } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

async function staffToken({ user, tenantId, type = "TENANT_USER" }) {
  const session = await Session.create({
    _id: createId("session"),
    userId: user._id,
    tenantId,
    deviceId: "test-device",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return signAccessToken({
    id: user._id,
    type,
    tenantId,
    branchId: user.branchId,
    role: user.role,
    permissions: ROLE_PERMISSIONS[user.role] ?? [],
    deviceId: "test-device",
    securityVersion: user.securityVersion ?? 0,
    sessionId: session._id,
  });
}

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("customer app DTO uses shared one-active resolver when ops allows multiple", async () => {
  const tenant = {
    settings: { oneActiveSchemePerCustomer: true },
    operations: { multiSchemePerCustomer: true },
  };
  const caps = tenantPortalCapabilitiesDto(tenant);
  assert.equal(caps.multiScheme, true);
});

test("staff token tenant mismatch is rejected", async () => {
  const { tenant, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const otherTenantId = createId("tenant");
  const token = await staffToken({ user, tenantId: otherTenantId });
  const res = await request(app)
    .get("/api/v1/admin/settings/profile")
    .set("authorization", `Bearer ${token}`);
  assert.equal(res.status, 401);
});

test("staff token subject type mismatch is rejected", async () => {
  const { tenant, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await User.updateOne({ _id: user._id }, { $set: { type: UserType.TENANT_USER } });
  const token = await staffToken({ user, tenantId: tenant._id, type: "PLATFORM_USER" });
  const res = await request(app)
    .get("/api/v1/admin/settings/profile")
    .set("authorization", `Bearer ${token}`);
  assert.equal(res.status, 401);
});
