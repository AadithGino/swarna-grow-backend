import test from "node:test";
import assert from "node:assert/strict";
import { signAccessToken, verifyAccessToken } from "../src/services/token.service.js";
import { authenticate } from "../src/middlewares/auth.middleware.js";
import { User } from "../src/models/index.js";
import { UserStatus, UserType } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("access token is rejected after securityVersion bump", async () => {
  const { user } = await seedTenantUser();
  const token = bearerFor(user, ["*"]);
  const req = {
    headers: { authorization: `Bearer ${token}` },
    auth: undefined,
    scope: undefined,
    tenant: undefined,
  };
  const next = (error) => {
    if (error) throw error;
  };
  await authenticate(req, {}, next);
  assert.equal(req.auth.id, user._id);

  await User.updateOne({ _id: user._id }, { $inc: { securityVersion: 1 } });
  await assert.rejects(
    () => authenticate(req, {}, next),
    (error) => error.statusCode === 401,
  );
});

test("valid securityVersion claim allows authentication", async () => {
  const userId = createId("user");
  const tenantId = createId("tenant");
  await User.create({
    _id: userId,
    type: UserType.TENANT_USER,
    tenantId,
    role: "TENANT_OWNER",
    name: "Owner",
    mobile: "+919900000001",
    status: UserStatus.ACTIVE,
    securityVersion: 2,
  });
  const token = signAccessToken({
    id: userId,
    type: UserType.TENANT_USER,
    tenantId,
    role: "TENANT_OWNER",
    permissions: ["*"],
    securityVersion: 2,
  });
  verifyAccessToken(token);
  assert.ok(token);
});
