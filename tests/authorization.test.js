import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import request from "supertest";
import { createApp } from "../src/app.js";
import { TenantRole, UserStatus, UserType } from "../src/constants/enums.js";
import { Customer } from "../src/models/index.js";
import { Permission, ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { createId } from "../src/lib/ids.js";
import { User } from "../src/models/index.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

let app;
function getApp() {
  if (!app) app = createApp();
  return app;
}

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

/** Representative admin route per permission module: [permissionNeeded, method, path, body?] */
const MATRIX = [
  [Permission.CUSTOMER_READ, "get", "/api/v1/admin/customers"],
  [Permission.CUSTOMER_BLOCK, "post", `/api/v1/admin/customers/${createId("customer")}/block`, {}],
  [Permission.AUDIT_READ, "get", "/api/v1/admin/audit-events"],
  [Permission.CASH_HANDOVER_ACCEPT, "post", `/api/v1/admin/cash/handovers/${createId("handover")}/accept`],
  [Permission.SETTINGS_WRITE, "post", "/api/v1/admin/uploads/presign", { purpose: "KYC_DOCUMENT", fileName: "a.jpg", contentType: "image/jpeg", sizeBytes: 1000 }],
  [Permission.REPORT_READ, "get", "/api/v1/admin/dashboard/summary"],
  [Permission.PAYMENT_RECORD, "post", "/api/v1/admin/payments", { schemeId: createId("scheme"), amountPaise: 10000, mode: "CASH" }],
  [Permission.BRANCH_WRITE, "post", "/api/v1/admin/branches", { code: "X1", name: "Extra" }],
];

const STAFF_MATRIX = [
  [Permission.CUSTOMER_READ, "get", "/api/v1/staff/customers"],
  [Permission.CUSTOMER_WRITE, "post", "/api/v1/staff/customers", { name: "New", mobile: "+919811122233", address: "Staff test address" }],
  [Permission.CUSTOMER_KYC, "put", `/api/v1/staff/customers/${createId("customer")}/kyc`, {}],
  [Permission.CUSTOMER_PASSWORD_WRITE, "post", `/api/v1/staff/customers/${createId("customer")}/set-password`, { password: "1234" }],
  [Permission.PLAN_READ, "get", "/api/v1/staff/scheme-plans"],
  [Permission.SCHEME_WRITE, "post", "/api/v1/staff/schemes/enrol", { customerId: createId("customer"), planId: createId("schemePlan") }],
  [Permission.SCHEME_READ, "get", `/api/v1/staff/schemes/${createId("scheme")}`],
  [Permission.PAYMENT_RECORD, "post", "/api/v1/staff/payments", { schemeId: createId("scheme"), amountPaise: 10000, mode: "CASH" }],
  [Permission.PAYMENT_READ, "get", "/api/v1/staff/payments"],
  [Permission.CASH_READ, "get", "/api/v1/staff/cash/summary"],
  [Permission.CASH_HANDOVER, "post", "/api/v1/staff/cash/handovers", { amountPaise: 10000 }],
  [Permission.REPORT_READ, "get", "/api/v1/staff/dues"],
  [Permission.GRIEVANCE_READ, "get", "/api/v1/staff/grievances"],
  [Permission.GRIEVANCE_REPLY, "post", `/api/v1/staff/grievances/${createId("grievance")}/messages`, { body: "Reply" }],
  [Permission.GOLD_RATE_READ, "get", "/api/v1/staff/gold-rate/current"],
  [Permission.AUDIT_READ, "get", `/api/v1/staff/customers/${createId("customer")}/audit-events`],
];

test("staff role change revokes refresh sessions", async () => {
  const password = "1234";
  const { tenant, branch, user: owner } = await seedTenantUser({ role: TenantRole.TENANT_OWNER, mobile: "+919811144400", password });
  const staff = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branch._id,
    role: TenantRole.BRANCH_STAFF,
    name: "Staff Member",
    mobile: "+919811144401",
    passwordHash: await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_STAFF],
  });
  const login = await request(getApp())
    .post("/api/v1/auth/login")
    .set("x-forwarded-for", `10.0.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`)
    .send({ tenantCode: tenant.code, mobile: staff.mobile, password, platform: "web", deviceId: "staff-device" })
    .expect(200);
  const refreshToken = login.body.data.refreshToken;
  const ownerToken = bearerFor(owner);
  await request(getApp())
    .patch(`/api/v1/admin/staff/${staff._id}`)
    .set("authorization", `Bearer ${ownerToken}`)
    .set("x-idempotency-key", randomUUID())
    .send({ role: TenantRole.BRANCH_MANAGER, expectedVersion: 1 })
    .expect(200);
  const refresh = await request(getApp()).post("/api/v1/auth/refresh").send({ refreshToken });
  assert.equal(refresh.status, 401);
  assert.equal(refresh.body.error.code, "UNAUTHENTICATED");
});

for (const role of Object.keys(ROLE_PERMISSIONS)) {
  test(`authorization matrix for ${role}`, async () => {
    const { user } = await seedTenantUser({ role: TenantRole[role], mobile: `+9198${role.length}${String(Date.now()).slice(-7)}` });
    const token = bearerFor(user);
    const granted = new Set(ROLE_PERMISSIONS[role]);
    const hasAll = granted.has("*");

    for (const [permission, method, path, body] of MATRIX) {
      const allowed = hasAll || granted.has(permission);
      let response;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          response = await request(getApp())[method](path)
            .set("authorization", `Bearer ${token}`)
            .set("x-idempotency-key", randomUUID())
            .send(body);
          break;
        } catch (error) {
          if (error?.code !== "ECONNRESET" || attempt === 2) throw error;
        }
      }
      if (allowed) {
        assert.notEqual(response.status, 403, `${role} should not be forbidden on ${method.toUpperCase()} ${path} (${permission})`);
      } else {
        assert.equal(response.status, 403, `${role} must be forbidden on ${method.toUpperCase()} ${path} (${permission})`);
        assert.equal(response.body.error.code, "FORBIDDEN");
      }
    }
  });

  test(`staff route authorization matrix for ${role}`, async () => {
    const { user } = await seedTenantUser({
      role: TenantRole[role],
      mobile: `+9196${role.length}${String(Date.now()).slice(-7)}`,
    });
    const token = bearerFor(user);
    const granted = new Set(ROLE_PERMISSIONS[role]);
    const hasAll = granted.has("*");

    for (const [permission, method, path, body] of STAFF_MATRIX) {
      const allowed = hasAll || granted.has(permission);
      let response;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          response = await request(getApp())[method](path)
            .set("authorization", `Bearer ${token}`)
            .set("x-idempotency-key", randomUUID())
            .send(body ?? {});
          break;
        } catch (error) {
          if (error?.code !== "ECONNRESET" || attempt === 2) throw error;
        }
      }
      if (allowed) {
        assert.notEqual(response.status, 403, `${role} should not be forbidden on ${method.toUpperCase()} ${path} (${permission})`);
      } else {
        assert.equal(response.status, 403, `${role} must be forbidden on ${method.toUpperCase()} ${path} (${permission})`);
        assert.equal(response.body.error.code, "FORBIDDEN");
      }
    }
  });
}

test("COLLECTION_AGENT is forbidden on sensitive staff mutations", async () => {
  const { user, branch, tenant } = await seedTenantUser({
    role: TenantRole.COLLECTION_AGENT,
    mobile: "+919811155566",
  });
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: "C5555",
    name: "Blocked Customer",
    mobile: "+919811155577",
  });
  const token = bearerFor(user);
  const forbidden = [
    ["post", "/api/v1/staff/customers", { name: "New", mobile: "+919811122244", address: "Blocked staff address" }],
    ["put", `/api/v1/staff/customers/${customer._id}/kyc`, {}],
    ["post", "/api/v1/staff/schemes/enrol", { customerId: customer._id, planId: createId("schemePlan") }],
    ["post", `/api/v1/staff/grievances/${createId("grievance")}/messages`, { body: "No access" }],
  ];
  for (const [method, path, body] of forbidden) {
    const response = await request(getApp())[method](path)
      .set("authorization", `Bearer ${token}`)
      .set("x-idempotency-key", randomUUID())
      .send(body);
    assert.equal(response.status, 403, `${method.toUpperCase()} ${path} must be forbidden`);
    assert.equal(response.body.error.code, "FORBIDDEN");
  }
});
