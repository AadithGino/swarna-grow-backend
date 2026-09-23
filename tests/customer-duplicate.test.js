import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

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

test("duplicate mobile within same tenant returns CUSTOMER_MOBILE_EXISTS", async () => {
  const fixture = await seedTenantUser();
  const token = bearerFor(fixture.user);
  const mobile = "+919876543210";
  await seedCustomer({
    tenantId: fixture.tenant._id,
    branchId: fixture.branch._id,
    mobile,
    name: "Existing Customer",
  });

  const response = await request(app)
    .post("/api/v1/admin/customers")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      name: "Another Person",
      mobile,
      branchId: fixture.branch._id,
      address: "1 Test Street, City",
    })
    .expect(409);

  assert.equal(response.body.success, false);
  assert.equal(response.body.error.code, "CUSTOMER_MOBILE_EXISTS");
  assert.match(response.body.error.message, /mobile/i);
  assert.ok(Array.isArray(response.body.error.details));
  assert.equal(response.body.error.details[0]?.field, "body.mobile");
});

test("duplicate mobile is detected when formats differ (+91 vs 10-digit)", async () => {
  const fixture = await seedTenantUser();
  const token = bearerFor(fixture.user);
  await seedCustomer({
    tenantId: fixture.tenant._id,
    branchId: fixture.branch._id,
    mobile: "+919876543299",
    name: "Format Mismatch Existing",
  });

  const response = await request(app)
    .post("/api/v1/admin/customers")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      name: "Format Mismatch New",
      mobile: "9876543299",
      branchId: fixture.branch._id,
      address: "2 Test Street, City",
    })
    .expect(409);

  assert.equal(response.body.error.code, "CUSTOMER_MOBILE_EXISTS");
});

test("same mobile may exist on different tenants", async () => {
  const mobile = "+919876543211";
  const a = await seedTenantUser({ tenantCode: "JEWELA" });
  const b = await seedTenantUser({ tenantCode: "JEWELB" });
  await seedCustomer({ tenantId: a.tenant._id, branchId: a.branch._id, mobile });

  const response = await request(app)
    .post("/api/v1/admin/customers")
    .set("Authorization", `Bearer ${bearerFor(b.user)}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      name: "Cross Tenant OK",
      mobile,
      branchId: b.branch._id,
      address: "3 Test Street, City",
    })
    .expect(201);

  assert.equal(response.body.success, true);
  assert.equal(response.body.data.mobile, mobile);
});
