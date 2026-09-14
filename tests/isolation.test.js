import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { AuditEvent, CashHandover, Customer, Payment, Scheme } from "../src/models/index.js";
import { CashHandoverStatus, HandoverInitiator, PaymentMode, PaymentSource, PaymentStatus, TenantRole } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { bearerFor, resetTestDb, seedBranch, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function seedOwnedResources(fixture) {
  const customer = await seedCustomer({ tenantId: fixture.tenant._id, branchId: fixture.branch._id, mobile: `+9188${String(Date.now()).slice(-8)}` });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: fixture.tenant._id,
    branchId: fixture.branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-${Date.now()}`,
    planSnapshot: { paymentPattern: "FIXED" },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installments: [],
    createdBy: fixture.user._id,
  });
  const payment = await Payment.create({
    _id: createId("payment"),
    tenantId: fixture.tenant._id,
    branchId: fixture.branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    receiptNumber: `RCP-${Date.now()}`,
    amountPaise: 10000,
    mode: PaymentMode.CASH,
    status: PaymentStatus.SUCCESS,
    source: PaymentSource.PORTAL,
    collectedBy: fixture.user._id,
  });
  const handover = await CashHandover.create({
    _id: createId("handover"),
    tenantId: fixture.tenant._id,
    branchId: fixture.branch._id,
    staffId: fixture.user._id,
    amountPaise: 10000,
    initiator: HandoverInitiator.STAFF,
    status: CashHandoverStatus.PENDING,
    submittedAt: new Date(),
  });
  const audit = await AuditEvent.create({
    _id: createId("audit"),
    tenantId: fixture.tenant._id,
    branchId: fixture.branch._id,
    actorType: "USER",
    actorId: fixture.user._id,
    action: "CUSTOMER_CREATED",
    entityType: "CUSTOMER",
    entityId: customer._id,
  });
  return { customer, scheme, payment, handover, audit };
}

test("tenant A cannot read tenant B resources by id (404 not 403)", async () => {
  const a = await seedTenantUser({ role: TenantRole.TENANT_OWNER, mobile: "+919811100010", tenantCode: "TENA" });
  const b = await seedTenantUser({ role: TenantRole.TENANT_OWNER, mobile: "+919811100011", tenantCode: "TENB" });
  const owned = await seedOwnedResources(b);
  const token = bearerFor(a.user);

  for (const path of [
    `/api/v1/admin/customers/${owned.customer._id}`,
    `/api/v1/admin/schemes/${owned.scheme._id}`,
    `/api/v1/admin/payments/${owned.payment._id}`,
    `/api/v1/admin/customers/${owned.customer._id}/audit-events`,
    `/api/v1/admin/cash/handovers/${owned.handover._id}`,
  ]) {
    const response = await request(app).get(path).set("authorization", `Bearer ${token}`);
    assert.equal(response.status, 404, path);
    assert.equal(response.body.error.code, "RESOURCE_NOT_FOUND");
    assert.notEqual(response.status, 403);
  }
});

test("branch-scoped user cannot read another branch customer (404)", async () => {
  const home = await seedTenantUser({ role: TenantRole.BRANCH_MANAGER, mobile: "+919811100012", tenantCode: "BRISO" });
  const otherBranch = await seedBranch({ tenantId: home.tenant._id, code: "OTHER" });
  const foreign = await Customer.create({
    _id: createId("customer"),
    tenantId: home.tenant._id,
    branchId: otherBranch._id,
    customerNumber: "C-OTHER",
    name: "Other Branch",
    mobile: "+918822233344",
  });
  const response = await request(app)
    .get(`/api/v1/admin/customers/${foreign._id}`)
    .set("authorization", `Bearer ${bearerFor(home.user)}`)
    .expect(404);
  assert.equal(response.body.error.code, "RESOURCE_NOT_FOUND");
});
