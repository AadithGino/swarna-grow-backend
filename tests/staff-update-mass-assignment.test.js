import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import argon2 from "argon2";
import { createApp } from "../src/app.js";
import { TenantRole, UserStatus, UserType } from "../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { User } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { updateStaff } from "../src/services/tenant.service.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("staff PATCH updates allowed profile fields over HTTP", async () => {
  const { tenant, branch, user: owner } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const staff = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branch._id,
    role: TenantRole.BRANCH_STAFF,
    name: "Before Name",
    mobile: "+919811100501",
    email: "before@example.com",
    passwordHash: await argon2.hash("original-secret"),
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_STAFF],
    version: 1,
  });
  const res = await request(app)
    .patch(`/api/v1/admin/staff/${staff._id}`)
    .set("authorization", `Bearer ${bearerFor(owner)}`)
    .set("x-idempotency-key", randomUUID())
    .send({ expectedVersion: 1, name: "After Name", email: "after@example.com" });
  assert.equal(res.status, 200);
  const persisted = await User.findById(staff._id).lean();
  assert.equal(persisted.name, "After Name");
  assert.equal(persisted.email, "after@example.com");
});

test("staff PATCH rejects unknown body fields with 400", async () => {
  const { user: owner } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const staff = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: owner.tenantId,
    branchId: owner.branchId,
    role: TenantRole.BRANCH_STAFF,
    name: "Staff",
    mobile: "+919811100502",
    passwordHash: await argon2.hash("1234"),
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_STAFF],
    version: 1,
  });
  const res = await request(app)
    .patch(`/api/v1/admin/staff/${staff._id}`)
    .set("authorization", `Bearer ${bearerFor(owner)}`)
    .set("x-idempotency-key", randomUUID())
    .send({ expectedVersion: 1, passwordHash: "nope" });
  assert.equal(res.status, 400);
  assert.equal(res.body.error?.code, "VALIDATION_FAILED");
});

test("updateStaff service whitelist drops privileged fields", async () => {
  const { tenant, branch, user: owner } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const originalHash = await argon2.hash("original-secret");
  const staff = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branch._id,
    role: TenantRole.BRANCH_STAFF,
    name: "Before Name",
    mobile: "+919811100503",
    passwordHash: originalHash,
    securityVersion: 3,
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_STAFF],
    version: 1,
  });
  const evilTenant = createId("tenant");
  await updateStaff({
    auth: { id: owner._id, tenantId: tenant._id, type: "TENANT_USER" },
    params: { staffId: staff._id },
    body: {
      expectedVersion: 1,
      name: "Service Updated",
      passwordHash: await argon2.hash("hacked"),
      tenantId: evilTenant,
      type: "PLATFORM_USER",
      securityVersion: 99,
      _id: createId("user"),
    },
  });
  const persisted = await User.findById(staff._id).select("+passwordHash").lean();
  assert.equal(persisted.name, "Service Updated");
  assert.equal(persisted.tenantId, tenant._id);
  assert.equal(persisted.type, UserType.TENANT_USER);
  assert.equal(persisted.securityVersion, 3);
  assert.equal(await argon2.verify(persisted.passwordHash, "original-secret"), true);
});
