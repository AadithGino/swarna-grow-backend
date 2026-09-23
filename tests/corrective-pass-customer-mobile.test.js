import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { Customer, Session } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
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

async function customerToken({ tenant, branch, customer }) {
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

test("admin PATCH can change customer mobile when unique in tenant", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+919811122200",
    name: "Mobile Change",
  });
  const res = await request(app)
    .patch(`/api/v1/admin/customers/${customer._id}`)
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", randomUUID())
    .send({ mobile: "+919811122299", expectedVersion: 1 });
  assert.equal(res.status, 200);
  const persisted = await Customer.findById(customer._id).lean();
  assert.equal(persisted.mobile, "+919811122299");
});

test("admin PATCH rejects mobile already used by another customer", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+919822233300",
    name: "Existing",
  });
  const target = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+919833344400",
    name: "Target",
  });
  const res = await request(app)
    .patch(`/api/v1/admin/customers/${target._id}`)
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", randomUUID())
    .send({ mobile: "+919822233300", expectedVersion: 1 });
  assert.equal(res.status, 409);
  assert.equal(res.body.error?.code ?? res.body.code, "CUSTOMER_MOBILE_EXISTS");
});

test("customer self-service PATCH rejects mobile field", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+919844455500",
    name: "Self Service",
  });
  const token = await customerToken({ tenant, branch, customer });
  const res = await request(app)
    .patch("/api/v1/app/profile")
    .set("authorization", `Bearer ${token}`)
    .send({ mobile: "+919855566600", name: "Self Service" });
  assert.ok([400, 422].includes(res.status));
  const persisted = await Customer.findById(customer._id).lean();
  assert.equal(persisted.mobile, "+919844455500");
});
