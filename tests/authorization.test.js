import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { TenantRole } from "../src/constants/enums.js";
import { Permission, ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { createId } from "../src/lib/ids.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

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
  [Permission.REPORT_READ, "get", "/api/v1/admin/customers/analytics"],
  [Permission.PAYMENT_RECORD, "post", "/api/v1/admin/payments", { schemeId: createId("scheme"), amountPaise: 10000, mode: "CASH" }],
  [Permission.BRANCH_WRITE, "post", "/api/v1/admin/branches", { code: "X1", name: "Extra" }],
];

for (const role of Object.keys(ROLE_PERMISSIONS)) {
  test(`authorization matrix for ${role}`, async () => {
    const { user } = await seedTenantUser({ role: TenantRole[role], mobile: `+9198${role.length}${String(Date.now()).slice(-7)}` });
    const token = bearerFor(user);
    const granted = new Set(ROLE_PERMISSIONS[role]);
    const hasAll = granted.has("*");

    for (const [permission, method, path, body] of MATRIX) {
      const allowed = hasAll || granted.has(permission);
      const response = await request(app)[method](path)
        .set("authorization", `Bearer ${token}`)
        .set("x-idempotency-key", randomUUID())
        .send(body);
      if (allowed) {
        assert.notEqual(response.status, 403, `${role} should not be forbidden on ${method.toUpperCase()} ${path} (${permission})`);
      } else {
        assert.equal(response.status, 403, `${role} must be forbidden on ${method.toUpperCase()} ${path} (${permission})`);
        assert.equal(response.body.error.code, "FORBIDDEN");
      }
    }
  });
}
