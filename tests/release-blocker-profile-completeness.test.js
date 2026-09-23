import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { Customer, Session } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { isCustomerProfileComplete } from "../src/lib/customer-app-dto.js";
import { signAccessToken } from "../src/services/token.service.js";
import {
  bearerFor,
  resetTestDb,
  seedCustomer,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";

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

test("profile completeness ignores stale profileCompletedAt when address missing", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+919811100001",
    name: "Ada Lovelace",
  });
  await Customer.updateOne(
    { _id: customer._id },
    { $set: { profileCompletedAt: new Date() }, $unset: { address: 1 } },
  );
  const persisted = await Customer.findById(customer._id).lean();
  assert.equal(isCustomerProfileComplete(persisted), false);

  const token = await customerAccessToken({ tenant, branch, customer });
  const profile = await request(app)
    .get("/api/v1/app/profile")
    .set("authorization", `Bearer ${token}`);
  assert.equal(profile.status, 200);
  assert.equal(profile.body.data.profileComplete, false);
  assert.equal(profile.body.data.profileCompleteness.complete, false);
});

test("profile completeness true when all required fields present", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+919811100002",
    name: "Complete User",
  });
  await Customer.updateOne(
    { _id: customer._id },
    {
      $set: {
        address: "12 Church Street, Bengaluru",
        profileCompletedAt: new Date(),
      },
    },
  );
  const persisted = await Customer.findById(customer._id).lean();
  assert.equal(isCustomerProfileComplete(persisted), true);

  const token = await customerAccessToken({ tenant, branch, customer });
  const profile = await request(app)
    .get("/api/v1/app/profile")
    .set("authorization", `Bearer ${token}`);
  assert.equal(profile.status, 200);
  assert.equal(profile.body.data.profileComplete, true);
});

test("profile completeness false after required field removed even if profileCompletedAt remains", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+919811100003",
    name: "Complete User",
  });
  await Customer.updateOne(
    { _id: customer._id },
    {
      $set: {
        address: "221B Baker Street",
        profileCompletedAt: new Date(),
      },
    },
  );

  const patch = await request(app)
    .patch(`/api/v1/admin/customers/${customer._id}`)
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", randomUUID())
    .send({ name: "Customer", expectedVersion: 1 });
  assert.equal(patch.status, 200);

  const persisted = await Customer.findById(customer._id).lean();
  assert.ok(persisted.profileCompletedAt, "legacy timestamp may remain on admin update");
  assert.equal(isCustomerProfileComplete(persisted), false);

  const token = await customerAccessToken({ tenant, branch, customer });
  const profile = await request(app)
    .get("/api/v1/app/profile")
    .set("authorization", `Bearer ${token}`);
  assert.equal(profile.status, 200);
  assert.equal(profile.body.data.profileComplete, false);
});
