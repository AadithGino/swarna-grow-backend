import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { Session, Tenant } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { createApp } from "../src/app.js";
import { signAccessToken } from "../src/services/token.service.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { TenantRole } from "../src/constants/enums.js";

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

test("customer app maintenance blocks app routes with 503", async () => {
  const { tenant, branch } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "settings.customerAppMaintenance": true } },
  );
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerAccessToken({ tenant, branch, customer });
  const blocked = await request(app)
    .get("/api/v1/app/home")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.error?.code, "APP_MAINTENANCE");

  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "settings.customerAppMaintenance": false } },
  );
  const ok = await request(app)
    .get("/api/v1/app/home")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(ok.status, 200);
});
