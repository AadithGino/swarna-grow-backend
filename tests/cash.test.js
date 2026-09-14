import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { CashHandover, Payment } from "../src/models/index.js";
import { CashHandoverStatus, HandoverInitiator, PaymentMode, PaymentSource, PaymentStatus, TenantRole } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { cashBalance, createHandover, settleHandover } from "../src/services/cash.service.js";
import { reversePayment } from "../src/services/payment.service.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await stopTestDb();
});
test.beforeEach(async () => { await resetTestDb(); });

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

test("only CASH success payments move staff cash-in-hand", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.BRANCH_STAFF, mobile: "+919811122255" });
  await Payment.create({
    _id: createId("payment"), tenantId: tenant._id, branchId: branch._id, schemeId: createId("scheme"), customerId: createId("customer"),
    receiptNumber: "RCP-UPI-1", amountPaise: 80000, mode: PaymentMode.UPI, status: PaymentStatus.SUCCESS, source: PaymentSource.STAFF_APP, collectedBy: user._id, paidAt: new Date(),
  });
  await Payment.create({
    _id: createId("payment"), tenantId: tenant._id, branchId: branch._id, schemeId: createId("scheme"), customerId: createId("customer"),
    receiptNumber: "RCP-CASH-1", amountPaise: 25000, mode: PaymentMode.CASH, status: PaymentStatus.SUCCESS, source: PaymentSource.STAFF_APP, collectedBy: user._id, paidAt: new Date(),
  });
  const balance = await cashBalance({ tenantId: tenant._id, branchId: branch._id, staffId: user._id });
  assert.equal(balance.cashCollectedPaise, 25000);
  assert.equal(balance.cashInHandPaise, 25000);
});

test("discrepancy leaves shortfall on staff cash-in-hand", async () => {
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
  req.body = { acceptedAmountPaise: 70000, reason: "short" };
  const settled = await settleHandover(req, "accept");
  assert.equal(settled.status, CashHandoverStatus.DISCREPANCY);
  const balance = await cashBalance({ tenantId: tenant._id, branchId: branch._id, staffId: user._id });
  assert.equal(balance.cashInHandPaise, 30000);
});

test("payment reverse after accepted handover does not rewrite the handover", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER, mobile: "+919811122277" });
  const { Scheme } = await import("../src/models/index.js");
  const { recordPayment } = await import("../src/services/payment.service.js");
  const customerId = createId("customer");
  const scheme = await Scheme.create({
    _id: createId("scheme"), tenantId: tenant._id, branchId: branch._id, customerId, planId: createId("schemePlan"),
    enrollmentNumber: `ENR-REV-${Date.now()}`, planSnapshot: { paymentPattern: "FIXED", paymentRules: { partialPaymentAllowed: true, minPaymentPaise: 1000 } },
    valueBasis: "CASH", paymentPattern: "FIXED", status: "ACTIVE", startDate: "2026-01-01", maturityDate: "2026-12-01",
    installments: [{ number: 1, dueDate: "2026-01-05", amountPaise: 40000, paidPaise: 0, status: "DUE", graceEndsAt: "2026-01-10" }],
    version: 1, createdBy: user._id,
  });
  const payment = await recordPayment({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    baseUrl: "/api/v1/admin",
    headers: { "user-agent": "test" },
    ip: "127.0.0.1",
    body: { schemeId: scheme._id, amountPaise: 40000, mode: "CASH", expectedVersion: 1 },
    query: {},
  });
  const handover = await CashHandover.create({
    _id: createId("handover"), tenantId: tenant._id, branchId: branch._id, staffId: user._id, amountPaise: 40000,
    initiator: HandoverInitiator.STAFF, status: CashHandoverStatus.ACCEPTED, submittedAt: new Date(), settledAt: new Date(), settledBy: user._id, acceptedAmountPaise: 40000,
  });
  await reversePayment({
    auth: { id: user._id, tenantId: tenant._id },
    scope: { tenantId: tenant._id },
    params: { paymentId: payment._id },
    body: { reason: "Customer dispute" },
    headers: { "user-agent": "test" },
    ip: "127.0.0.1",
  });
  const unchanged = await CashHandover.findById(handover._id).lean();
  assert.equal(unchanged.status, CashHandoverStatus.ACCEPTED);
  assert.equal(unchanged.amountPaise, 40000);
  const refreshedPayment = await Payment.findById(payment._id).lean();
  assert.equal(refreshedPayment.status, PaymentStatus.REVERSED);
});
