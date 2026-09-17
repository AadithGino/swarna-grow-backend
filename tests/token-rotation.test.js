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

test("concurrent refresh rotation allows exactly one successor token", async () => {
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
  const loader = async () => ({
    ...subject,
    securityVersion: user.securityVersion ?? 0,
  });
  const results = await Promise.allSettled([
    rotateSession(refreshToken, loader),
    rotateSession(refreshToken, loader),
  ]);
  const fulfilled = results.filter((row) => row.status === "fulfilled");
  const rejected = results.filter((row) => row.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof AppError);
  assert.equal(rejected[0].reason.code, "TOKEN_REUSE_DETECTED");
  assert.ok(fulfilled[0].value.refreshToken);
  assert.equal(
    await Session.countDocuments({ userId: user._id, revokedAt: null, consumedAt: null }),
    0,
  );
  assert.equal(await Session.countDocuments({ userId: user._id, revokedAt: { $ne: null } }), 2);
});
