import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { AuditEvent, Customer } from "../src/models/index.js";
import { TenantRole } from "../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { signAccessToken } from "../src/services/token.service.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function bearerFor(user, permissions = ROLE_PERMISSIONS[user.role]) {
  return signAccessToken({
    id: user._id,
    type: "TENANT_USER",
    tenantId: user.tenantId,
    branchId: user.branchId,
    role: user.role,
    permissions,
    deviceId: "test-device",
  });
}

test("BRANCH_STAFF is forbidden from handover accept, cash adjustments, audit and customer analytics", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.BRANCH_STAFF, mobile: "+919811122233" });
  const token = bearerFor(user);
  const handoverId = createId("handover");
  for (const [method, path] of [
    ["post", `/api/v1/admin/cash/handovers/${handoverId}/accept`],
    ["post", "/api/v1/admin/cash/adjustments"],
    ["get", "/api/v1/admin/audit-events"],
    ["get", "/api/v1/admin/customers/analytics"],
  ]) {
    const response = await request(app)[method](path)
      .set("authorization", `Bearer ${token}`)
      .set("x-idempotency-key", randomUUID())
      .send(method === "post" && path.includes("adjustments") ? { staffId: user._id, direction: "CREDIT", amountPaise: 100, reason: "test" } : undefined)
      .expect(403);
    assert.equal(response.body.error.code, "FORBIDDEN");
    assert.equal(tenant._id, user.tenantId);
    assert.equal(branch._id, user.branchId);
  }
});

test("branch-scoped user gets 404 for another branch customer audit-events", async () => {
  const branchA = await seedTenantUser({ role: TenantRole.BRANCH_MANAGER, mobile: "+919811100001" });
  const otherBranchId = createId("branch");
  const foreignCustomer = await Customer.create({
    _id: createId("customer"),
    tenantId: branchA.tenant._id,
    branchId: otherBranchId,
    customerNumber: "C-FOREIGN",
    name: "Other Branch Customer",
    mobile: "+919822233344",
  });
  await AuditEvent.create({
    _id: createId("audit"),
    tenantId: branchA.tenant._id,
    branchId: otherBranchId,
    actorType: "USER",
    actorId: branchA.user._id,
    action: "CUSTOMER_CREATED",
    entityType: "CUSTOMER",
    entityId: foreignCustomer._id,
  });
  const token = bearerFor(branchA.user);
  const response = await request(app)
    .get(`/api/v1/admin/customers/${foreignCustomer._id}/audit-events`)
    .set("authorization", `Bearer ${token}`)
    .expect(404);
  assert.equal(response.body.error.code, "RESOURCE_NOT_FOUND");
});
