import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { Payment } from "../src/models/index.js";
import { PaymentMode, PaymentSource, PaymentStatus, TenantRole } from "../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { signAccessToken } from "../src/services/token.service.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => {
  // Idempotency middleware completes with void; give it time before tearing down Mongo.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await stopTestDb();
});
test.beforeEach(async () => { await resetTestDb(); });

function bearerFor(user) {
  return signAccessToken({
    id: user._id, type: "TENANT_USER", tenantId: user.tenantId, branchId: user.branchId, role: user.role,
    permissions: ROLE_PERMISSIONS[user.role] ?? [], deviceId: "test-device",
  });
}

test("second full-balance cash handover is rejected while first is still pending", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.BRANCH_STAFF, mobile: "+919811122244" });
  await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: createId("scheme"),
    customerId: createId("customer"),
    receiptNumber: "RCP-TEST-1",
    amountPaise: 50000,
    mode: PaymentMode.CASH,
    status: PaymentStatus.SUCCESS,
    source: PaymentSource.STAFF_APP,
    collectedBy: user._id,
    paidAt: new Date(),
  });
  const token = bearerFor(user);
  const first = await request(app)
    .post("/api/v1/staff/cash/handovers")
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", randomUUID())
    .send({ amountPaise: 50000 })
    .expect(201);
  assert.equal(first.body.data.amountPaise, 50000);
  assert.equal(first.body.data.balance.cashInHandPaise, 0);
  assert.equal(first.body.data.balance.cashPendingAcceptancePaise, 50000);

  const second = await request(app)
    .post("/api/v1/staff/cash/handovers")
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", randomUUID())
    .send({ amountPaise: 50000 })
    .expect(422);
  assert.equal(second.body.error.code, "CASH_HANDOVER_AMOUNT_EXCEEDS_BALANCE");
});
