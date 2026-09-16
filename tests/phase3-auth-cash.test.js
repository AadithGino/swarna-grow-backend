import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import argon2 from "argon2";
import { createApp } from "../src/app.js";
import { CashHandover, Customer, Payment, Tenant, User } from "../src/models/index.js";
import { HandoverInitiator, PaymentMode, PaymentSource, PaymentStatus, TenantRole, TenantStatus, UserStatus, UserType } from "../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { createId } from "../src/lib/ids.js";
import { cancelHandover, cashBalance, createHandover, settleHandover } from "../src/services/cash.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("login without tenantCode returns TENANT_SELECTION_REQUIRED when mobile spans tenants", async () => {
  const password = "SecurePass!123";
  const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  const tenants = [];
  for (const code of ["ALPHA", "BETA"]) {
    const tenant = await Tenant.create({ _id: createId("tenant"), code, name: `${code} Jewels`, mobile: `+91970000${code === "ALPHA" ? "01" : "02"}`, status: TenantStatus.ACTIVE, branding: { displayName: `${code} Display` } });
    tenants.push(tenant);
    await User.create({
      _id: createId("user"), type: UserType.TENANT_USER, tenantId: tenant._id, role: TenantRole.TENANT_OWNER, name: "Shared Mobile",
      mobile: "+919811100099", passwordHash: hash, status: UserStatus.ACTIVE, permissions: ROLE_PERMISSIONS[TenantRole.TENANT_OWNER],
    });
  }
  const response = await request(app)
    .post("/api/v1/auth/login")
    .send({ mobile: "+919811100099", password, deviceId: "device-1", platform: "web" })
    .expect(409);
  assert.equal(response.body.error.code, "TENANT_SELECTION_REQUIRED");
  assert.equal(response.body.error.details.tenants.length, 2);
  assert.ok(response.body.error.details.tenants.every((row) => row.tenantCode && row.displayName));
  assert.equal(tenants.length, 2);
});

test("tenant resolve by mobile looks up customers and returns 404 when missing", async () => {
  const { tenant } = await seedTenantUser({ mobile: "+919811122200" });
  await Customer.create({ _id: createId("customer"), tenantId: tenant._id, branchId: createId("branch"), customerNumber: "C1", name: "Cust", mobile: "+919833344455" });
  const found = await request(app).get("/api/v1/public/tenants/resolve").query({ mobile: "+919833344455" }).expect(200);
  assert.equal(found.body.data.tenantCode, "TESTCO");
  assert.equal(found.body.data.tenants[0].tenantCode, "TESTCO");
  const missing = await request(app).get("/api/v1/public/tenants/resolve").query({ mobile: "+919800000000" }).expect(404);
  assert.equal(missing.body.error.code, "RESOURCE_NOT_FOUND");
  const jewellerMobile = await request(app).get("/api/v1/public/tenants/resolve").query({ mobile: tenant.mobile }).expect(404);
  assert.equal(jewellerMobile.body.error.code, "RESOURCE_NOT_FOUND");
});

test("accepting a partial cash amount marks DISCREPANCY and leaves shortfall in hand", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.BRANCH_STAFF, mobile: "+919811122266" });
  await Payment.create({
    _id: createId("payment"), tenantId: tenant._id, branchId: branch._id, schemeId: createId("scheme"), customerId: createId("customer"),
    receiptNumber: "RCP-DISC-1", amountPaise: 100000, mode: PaymentMode.CASH, status: PaymentStatus.SUCCESS, source: PaymentSource.STAFF_APP, collectedBy: user._id, paidAt: new Date(),
  });
  const req = {
    auth: { id: user._id, tenantId: tenant._id, branchId: branch._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    body: { amountPaise: 100000 },
    headers: { "user-agent": "test" },
    ip: "127.0.0.1",
  };
  const created = await createHandover(req, HandoverInitiator.STAFF);
  req.params = { handoverId: created._id };
  req.body = { acceptedAmountPaise: 70000, reason: "Counted short" };
  const settled = await settleHandover(req, "accept");
  assert.equal(settled.status, "DISCREPANCY");
  assert.equal(settled.discrepancyPaise, 30000);
  assert.equal(settled.discrepancyDirection, "SHORTFALL");
  const balance = await cashBalance({ tenantId: tenant._id, branchId: branch._id, staffId: user._id });
  assert.equal(balance.cashInHandPaise, 30000);
  const cancelledReq = {
    auth: { id: user._id, tenantId: tenant._id },
    params: {},
    headers: { "user-agent": "test" },
    ip: "127.0.0.1",
  };
  await Payment.create({
    _id: createId("payment"), tenantId: tenant._id, branchId: branch._id, schemeId: createId("scheme"), customerId: createId("customer"),
    receiptNumber: "RCP-DISC-2", amountPaise: 20000, mode: PaymentMode.CASH, status: PaymentStatus.SUCCESS, source: PaymentSource.STAFF_APP, collectedBy: user._id, paidAt: new Date(),
  });
  const second = await createHandover({ ...cancelledReq, scope: { tenantId: tenant._id, branchId: branch._id }, body: { amountPaise: 20000 } }, HandoverInitiator.STAFF);
  cancelledReq.params = { handoverId: second._id };
  const cancelled = await cancelHandover(cancelledReq);
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal((await CashHandover.findById(second._id)).status, "CANCELLED");
});
