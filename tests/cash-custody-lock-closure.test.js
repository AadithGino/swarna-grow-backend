import test from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import { CashHandover, Customer, Scheme, User } from "../src/models/index.js";
import { recordPayment, reversePayment } from "../src/services/payment.service.js";
import {
  CashHandoverStatus,
  HandoverInitiator,
  PaymentMode,
  PaymentSource,
  PaymentStatus,
  TenantRole,
  UserStatus,
  UserType,
} from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { cashBalance, createHandover, settleHandover } from "../src/services/cash.service.js";
import { AppError } from "../src/lib/app-error.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function branchManager({ tenant, branch }) {
  return User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branch._id,
    role: TenantRole.BRANCH_MANAGER,
    name: "Branch Manager",
    mobile: `+9198111${String(Date.now()).slice(-5)}`,
    passwordHash: await argon2.hash("1234"),
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_MANAGER],
  });
}

test("concurrent cash reversal and handover submission serialize on staff custody", async () => {
  const { tenant, branch, user: staff } = await seedTenantUser({ role: TenantRole.BRANCH_STAFF });
  const manager = await branchManager({ tenant, branch });
  const customerId = createId("customer");
  await Customer.create({
    _id: customerId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: "C-LOCK1",
    name: "Lock Customer",
    mobile: "+919811122301",
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    planId: createId("schemePlan"),
    enrollmentNumber: "ENR-LOCK1",
    planSnapshot: { paymentPattern: "FIXED", paymentRules: { partialPaymentAllowed: true, minPaymentPaise: 1000 } },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installments: [{ number: 1, dueDate: "2026-01-05", amountPaise: 100_000, paidPaise: 0, status: "DUE", graceEndsAt: "2026-01-10" }],
    version: 1,
    createdBy: staff._id,
  });
  const payment = await recordPayment({
    auth: { id: staff._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    baseUrl: "/api/v1/admin",
    headers: { "user-agent": "test" },
    ip: "127.0.0.1",
    body: { schemeId: scheme._id, amountPaise: 100_000, mode: PaymentMode.CASH, expectedVersion: 1 },
    query: {},
  });
  const reverseReq = {
    auth: { id: manager._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { paymentId: payment._id },
    body: { reason: "Customer refund test" },
    headers: { "user-agent": "test" },
    ip: "127.0.0.1",
  };
  const handoverReq = {
    auth: { id: staff._id, tenantId: tenant._id, branchId: branch._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    body: { amountPaise: 100_000 },
    headers: { "user-agent": "test" },
    ip: "127.0.0.1",
  };
  const outcomes = await Promise.allSettled([
    reversePayment(reverseReq),
    createHandover(handoverReq, HandoverInitiator.STAFF),
  ]);
  assert.equal(outcomes.filter((row) => row.status === "fulfilled").length, 1);
  const balance = await cashBalance({ tenantId: tenant._id, branchId: branch._id, staffId: staff._id });
  assert.ok(balance.availableForHandoverPaise >= 0);
  assert.ok(balance.cashPendingAcceptancePaise <= balance.cashInHandPaise);
});

test("concurrent handover accept and new submission serialize without over-committing pending", async () => {
  const { tenant, branch, user: staff } = await seedTenantUser({ role: TenantRole.BRANCH_STAFF });
  const manager = await branchManager({ tenant, branch });
  const customerId = createId("customer");
  await Customer.create({
    _id: customerId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: "C-LOCK2",
    name: "Lock Customer 2",
    mobile: "+919811122302",
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    planId: createId("schemePlan"),
    enrollmentNumber: "ENR-LOCK2",
    planSnapshot: { paymentPattern: "FIXED", paymentRules: { partialPaymentAllowed: true, minPaymentPaise: 1000 } },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installments: [{ number: 1, dueDate: "2026-01-05", amountPaise: 100_000, paidPaise: 0, status: "DUE", graceEndsAt: "2026-01-10" }],
    version: 1,
    createdBy: staff._id,
  });
  await recordPayment({
    auth: { id: staff._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    baseUrl: "/api/v1/admin",
    headers: { "user-agent": "test" },
    ip: "127.0.0.1",
    body: { schemeId: scheme._id, amountPaise: 100_000, mode: PaymentMode.CASH, expectedVersion: 1 },
    query: {},
  });
  const pending = await createHandover({
    auth: { id: staff._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    body: { amountPaise: 60_000 },
  }, HandoverInitiator.STAFF);
  const acceptReq = {
    auth: { id: manager._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { handoverId: pending._id },
    body: { acceptedAmountPaise: 60_000 },
  };
  const secondSubmitReq = {
    auth: { id: staff._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    body: { amountPaise: 60_000 },
  };
  const outcomes = await Promise.allSettled([
    settleHandover(acceptReq, "accept"),
    createHandover(secondSubmitReq, HandoverInitiator.STAFF),
  ]);
  const rejected = outcomes.filter((row) => row.status === "rejected");
  if (rejected.length > 0) {
    assert.ok(rejected[0].reason instanceof AppError);
    assert.equal(rejected[0].reason.code, "CASH_HANDOVER_AMOUNT_EXCEEDS_BALANCE");
  }
  const row = await CashHandover.findById(pending._id).lean();
  assert.ok([CashHandoverStatus.ACCEPTED, CashHandoverStatus.PENDING].includes(row.status));
  const balance = await cashBalance({ tenantId: tenant._id, branchId: branch._id, staffId: staff._id });
  assert.ok(balance.cashPendingAcceptancePaise <= balance.cashInHandPaise);
});
