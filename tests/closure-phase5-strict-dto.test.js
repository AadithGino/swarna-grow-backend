import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import argon2 from "argon2";
import { createApp } from "../src/app.js";
import {
  CashHandoverStatus,
  HandoverInitiator,
  KycStatus,
  PaymentMode,
  PaymentSource,
  PaymentStatus,
  TenantRole,
  UserType,
} from "../src/constants/enums.js";
import { CashHandover, Customer, Payment, User } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { createHandover, settleHandover } from "../src/services/cash.service.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function ownerWithCash() {
  const seeded = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const staff = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: seeded.tenant._id,
    branchId: seeded.branch._id,
    role: TenantRole.BRANCH_STAFF,
    name: "Cash Staff",
    mobile: `+9198112${String(Date.now()).slice(-5)}`,
    passwordHash: await argon2.hash("1234"),
    status: "ACTIVE",
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_STAFF],
  });
  await Payment.create({
    _id: createId("payment"),
    tenantId: seeded.tenant._id,
    branchId: seeded.branch._id,
    schemeId: createId("scheme"),
    customerId: createId("customer"),
    receiptNumber: `RCP-${Date.now()}`,
    amountPaise: 100_000,
    mode: PaymentMode.CASH,
    status: PaymentStatus.SUCCESS,
    source: PaymentSource.STAFF_APP,
    collectedBy: staff._id,
    paidAt: new Date(),
  });
  return { ...seeded, staff };
}

test("payment reverse without reason returns 400", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: createId("scheme"),
    customerId: createId("customer"),
    receiptNumber: "RCP-REV",
    amountPaise: 10_000,
    mode: PaymentMode.CASH,
    status: PaymentStatus.SUCCESS,
    source: PaymentSource.STAFF_APP,
    collectedBy: user._id,
    paidAt: new Date(),
  });
  const res = await request(app)
    .post(`/api/v1/admin/payments/${paymentId}/reverse`)
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", randomUUID())
    .send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error?.code, "VALIDATION_FAILED");
});

test("kyc verify rejects non-terminal status values", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: "C-KYC1",
    name: "KYC Test",
    mobile: "+919811100601",
    kyc: { status: KycStatus.SUBMITTED, type: "PAN", submittedAt: new Date() },
  });
  const res = await request(app)
    .post(`/api/v1/admin/customers/${customer._id}/kyc/verify`)
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", randomUUID())
    .send({ status: "SUBMITTED" });
  assert.equal(res.status, 400);
});

test("kyc verify REJECTED requires rejectionReason", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: "C-KYC2",
    name: "KYC Test 2",
    mobile: "+919811100602",
    kyc: { status: KycStatus.SUBMITTED, type: "PAN", submittedAt: new Date() },
  });
  const res = await request(app)
    .post(`/api/v1/admin/customers/${customer._id}/kyc/verify`)
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", randomUUID())
    .send({ status: "REJECTED" });
  assert.equal(res.status, 400);
  const ok = await request(app)
    .post(`/api/v1/admin/customers/${customer._id}/kyc/verify`)
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", randomUUID())
    .send({ status: "REJECTED", rejectionReason: "Document unreadable" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.kyc.status, "REJECTED");
});

test("handover accept ignores client discrepancyPaise and resolve requires explicit accepted", async () => {
  const { tenant, branch, user, staff } = await ownerWithCash();
  const staffReq = {
    auth: { id: staff._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    headers: {},
    ip: "127.0.0.1",
  };
  const created = await createHandover(
    { ...staffReq, body: { amountPaise: 100_000 } },
    HandoverInitiator.STAFF,
  );
  const ownerToken = bearerFor(user);
  const tampered = await request(app)
    .post(`/api/v1/admin/cash/handovers/${created._id}/accept`)
    .set("authorization", `Bearer ${ownerToken}`)
    .set("x-idempotency-key", randomUUID())
    .send({ acceptedAmountPaise: 90_000, discrepancyPaise: 1 });
  assert.equal(tampered.status, 400);

  await settleHandover({
    ...staffReq,
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    params: { handoverId: created._id },
    body: { acceptedAmountPaise: 90_000 },
  }, "accept");
  const row = await CashHandover.findById(created._id).lean();
  assert.equal(row.status, CashHandoverStatus.DISCREPANCY);
  assert.equal(row.discrepancyPaise, 10_000);

  const missingAccepted = await request(app)
    .post(`/api/v1/admin/cash/handovers/${created._id}/resolve-discrepancy`)
    .set("authorization", `Bearer ${ownerToken}`)
    .set("x-idempotency-key", randomUUID())
    .send({});
  assert.equal(missingAccepted.status, 400);

  const rejectResolve = await request(app)
    .post(`/api/v1/admin/cash/handovers/${created._id}/resolve-discrepancy`)
    .set("authorization", `Bearer ${ownerToken}`)
    .set("x-idempotency-key", randomUUID())
    .send({ accepted: false, reason: "Staff will re-submit correct amount" });
  assert.equal(rejectResolve.status, 200);
  assert.equal(rejectResolve.body.data.status, CashHandoverStatus.REJECTED);
});
