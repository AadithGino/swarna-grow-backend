import test from "node:test";
import assert from "node:assert/strict";
import { UserType } from "../src/constants/enums.js";
import { AppError } from "../src/lib/app-error.js";
import { Session } from "../src/models/index.js";
import { issueSession, rotateSession } from "../src/services/token.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("concurrent refresh rotation allows one successor and one idempotent refresh", async () => {
  const { tenant, branch, user } = await seedTenantUser();
  const subject = {
    id: user._id,
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branch._id,
    role: user.role,
    permissions: user.permissions ?? ["*"],
    securityVersion: user.securityVersion ?? 0,
  };
  const { refreshToken } = await issueSession(
    subject,
    { deviceId: "rotation-test", platform: "web" },
    { headers: {}, ip: "127.0.0.1" },
  );
  const familyId = (
    await Session.findOne({ userId: user._id, deviceId: "rotation-test" })
      .sort({ createdAt: -1 })
      .lean()
  )?.familyId;
  const loader = async () => ({
    ...subject,
    securityVersion: user.securityVersion ?? 0,
  });
  const results = await Promise.allSettled([
    rotateSession(refreshToken, loader),
    rotateSession(refreshToken, loader),
  ]);
  const fulfilled = results.filter((row) => row.status === "fulfilled");
  assert.equal(fulfilled.length, 2);
  const withRefresh = fulfilled.filter((row) => row.value.refreshToken);
  const accessOnly = fulfilled.filter((row) => !row.value.refreshToken);
  assert.equal(withRefresh.length, 1);
  assert.equal(accessOnly.length, 1);
  assert.equal(
    await Session.countDocuments({
      familyId,
      revokedAt: null,
      consumedAt: null,
    }),
    1,
  );
});

test("stale refresh reuse outside grace revokes the token family", async () => {
  const { tenant, branch, user } = await seedTenantUser();
  const subject = {
    id: user._id,
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branch._id,
    role: user.role,
    permissions: user.permissions ?? ["*"],
    securityVersion: user.securityVersion ?? 0,
  };
  const { refreshToken } = await issueSession(
    subject,
    { deviceId: "rotation-test", platform: "web" },
    { headers: {}, ip: "127.0.0.1" },
  );
  const familyId = (
    await Session.findOne({ userId: user._id, deviceId: "rotation-test" })
      .sort({ createdAt: -1 })
      .lean()
  )?.familyId;
  const loader = async () => ({
    ...subject,
    securityVersion: user.securityVersion ?? 0,
  });
  const first = await rotateSession(refreshToken, loader);
  assert.ok(first.refreshToken);

  const consumed = await Session.findOne({
    familyId,
    consumedAt: { $ne: null },
  }).lean();
  await Session.updateOne(
    { _id: consumed._id },
    { $set: { consumedAt: new Date(Date.now() - 60_000) } },
  );

  await assert.rejects(
    () => rotateSession(refreshToken, loader),
    (error) => error instanceof AppError && error.code === "TOKEN_REUSE_DETECTED",
  );
  assert.equal(
    await Session.countDocuments({ familyId, revokedAt: null }),
    0,
  );
});
