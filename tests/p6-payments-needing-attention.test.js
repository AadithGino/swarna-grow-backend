process.env.NODE_ENV = "test";
process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";

import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import argon2 from "argon2";
import { Permission } from "../src/constants/permissions.js";
import { UserStatus, UserType, TenantRole } from "../src/constants/enums.js";
import { Session, User } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

test("unified payments needing attention lists domains user can read", async () => {
  const { user } = await seedTenantUser({});
  const token = bearerFor(user);
  const res = await request(app)
    .get("/api/v1/admin/payments/needing-attention")
    .set("Authorization", `Bearer ${token}`)
    .query({ limit: 10 });
  assert.equal(res.status, 200);
  assert.ok(res.body.data);
  assert.ok(Array.isArray(res.body.data.items));
  assert.ok(typeof res.body.data.domainsIncluded === "object");
  assert.equal(res.body.data.domainsIncluded.ecommerce, true);
  assert.equal(res.body.data.domainsIncluded.digitalMetals, true);
  assert.ok(res.body.data.computedAt);
});

test("unified queue item shape includes refund obligation slot and transaction link fields", async () => {
  const { user } = await seedTenantUser({});
  const token = bearerFor(user);
  const res = await request(app)
    .get("/api/v1/admin/payments/needing-attention")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(res.status, 200);
  for (const row of res.body.data.items) {
    assert.ok(["ECOMMERCE", "DIGITAL_METALS"].includes(row.domain));
    assert.ok(typeof row.reasonLabel === "string");
    assert.ok(typeof row.nextActionLabel === "string");
    assert.ok(typeof row.amountPaise === "number");
    if (row.refundObligation) {
      assert.ok(row.refundObligation.refundCaseId);
      assert.equal(row.refundObligation.domain, row.domain);
    }
    if (row.transactionHref) assert.match(row.transactionHref, /^\//);
  }
});

async function tokenForPermissions(tenant, branch, permissions, mobileSuffix = "91") {
  const user = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branch._id,
    role: TenantRole.TENANT_ADMIN,
    name: "Scoped Reader",
    mobile: `+9188111${mobileSuffix}${Math.floor(Math.random() * 10000)}`,
    passwordHash: await argon2.hash("1234", {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    }),
    status: UserStatus.ACTIVE,
    permissions,
  });
  const session = await Session.create({
    _id: createId("session"),
    userId: user._id,
    tenantId: tenant._id,
    deviceId: "scoped",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  user.$locals.testSessionId = session._id;
  return bearerFor(user, permissions);
}

test("payments needing attention returns 403 without ecommerce or digital metals read", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const token = await tokenForPermissions(tenant, branch, [Permission.SCHEME_READ], "01");
  const res = await request(app)
    .get("/api/v1/admin/payments/needing-attention")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(res.status, 403);
});

test("ecommerce-only reader sees ecommerce domain flag only", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const token = await tokenForPermissions(tenant, branch, [Permission.ECOMMERCE_READ], "02");
  const res = await request(app)
    .get("/api/v1/admin/payments/needing-attention")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.domainsIncluded.ecommerce, true);
  assert.equal(res.body.data.domainsIncluded.digitalMetals, false);
});
