import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { CashAdjustment, CashHandover, Customer, Payment } from "../src/models/index.js";
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
  assert.equal(first.body.data.balance.cashInHandPaise, 50000);
  assert.equal(first.body.data.balance.cashPendingAcceptancePaise, 50000);
  assert.equal(first.body.data.balance.availableForHandoverPaise, 0);

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
  await Customer.create({
    _id: customerId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: "C-REV-1",
    name: "Reverse Customer",
    mobile: "+919811122278",
  });
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
  const paidAt = (await Payment.findById(payment._id)).paidAt;
  const handover = await CashHandover.create({
    _id: createId("handover"), tenantId: tenant._id, branchId: branch._id, staffId: user._id, amountPaise: 40000,
    initiator: HandoverInitiator.STAFF, status: CashHandoverStatus.ACCEPTED, submittedAt: new Date(paidAt.getTime() + 1000), settledAt: new Date(), settledBy: user._id, acceptedAmountPaise: 40000,
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
  const balance = await cashBalance({ tenantId: tenant._id, branchId: branch._id, staffId: user._id });
  assert.ok(balance.cashInHandPaise >= 0);
  const adjustment = await CashAdjustment.findOne({ staffId: user._id, tenantId: tenant._id }).lean();
  assert.ok(adjustment);
  assert.equal(adjustment.amountPaise, 40000);
  assert.equal(adjustment.direction, "CREDIT");
  assert.equal(unchanged._id, handover._id);
});

test("resolved handover shortfall creates cash adjustment", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.BRANCH_STAFF, mobile: "+919811122299" });
  await Payment.create({
    _id: createId("payment"), tenantId: tenant._id, branchId: branch._id, schemeId: createId("scheme"), customerId: createId("customer"),
    receiptNumber: "RCP-SHORT-1", amountPaise: 100000, mode: PaymentMode.CASH, status: PaymentStatus.SUCCESS, source: PaymentSource.STAFF_APP, collectedBy: user._id, paidAt: new Date(),
  });
  const req = {
    auth: { id: user._id, tenantId: tenant._id, branchId: branch._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    headers: {}, ip: "127.0.0.1",
  };
  const created = await createHandover({ ...req, body: { amountPaise: 100000 } }, HandoverInitiator.STAFF);
  await settleHandover({ ...req, params: { handoverId: created._id }, body: { acceptedAmountPaise: 90000 } }, "accept");
  await settleHandover({
    ...req,
    params: { handoverId: created._id },
    body: { accepted: true, acceptedAmountPaise: 90000 },
  }, "resolve-discrepancy");
  const adjustment = await CashAdjustment.findOne({ staffId: user._id }).lean();
  assert.ok(adjustment);
  assert.equal(adjustment.amountPaise, 10000);
  // Shortfall: less cash accepted than declared — restore the difference to staff (see cash.service).
  assert.equal(adjustment.direction, "CREDIT");
  const balance = await cashBalance({ tenantId: tenant._id, branchId: branch._id, staffId: user._id });
  assert.equal(balance.adjustmentPaise, 10000);
});

test("cash payment reverse with pending handover does not create a cash adjustment", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.BRANCH_STAFF, mobile: "+919811122288" });
  const customerId = createId("customer");
  const schemeId = createId("scheme");
  await Customer.create({
    _id: customerId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: "C-PEND-1",
    name: "Pending Customer",
    mobile: "+919811122289",
  });
  const { Scheme } = await import("../src/models/index.js");
  await Scheme.create({
    _id: schemeId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    planId: createId("schemePlan"),
    enrollmentNumber: "ENR-PEND-1",
    planSnapshot: { paymentPattern: "FIXED", paymentRules: { partialPaymentAllowed: true, minPaymentPaise: 1000 } },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installments: [{ number: 1, dueDate: "2026-01-05", amountPaise: 35000, paidPaise: 35000, status: "PAID", graceEndsAt: "2026-01-10" }],
    version: 1,
    createdBy: user._id,
  });
  const payment = await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId,
    customerId,
    receiptNumber: "RCP-PEND-1",
    amountPaise: 35000,
    mode: PaymentMode.CASH,
    status: PaymentStatus.SUCCESS,
    source: PaymentSource.STAFF_APP,
    collectedBy: user._id,
    paidAt: new Date(),
  });
  await CashHandover.create({
    _id: createId("handover"),
    tenantId: tenant._id,
    branchId: branch._id,
    staffId: user._id,
    amountPaise: 35000,
    initiator: HandoverInitiator.STAFF,
    status: CashHandoverStatus.PENDING,
    submittedAt: new Date(),
  });
  await reversePayment({
    auth: { id: user._id, tenantId: tenant._id },
    scope: { tenantId: tenant._id },
    params: { paymentId: payment._id },
    body: { reason: "Wrong amount" },
    headers: { "user-agent": "test" },
    ip: "127.0.0.1",
  });
  assert.equal(await CashAdjustment.countDocuments({ staffId: user._id }), 0);
});

test("adminCashReport scopes collected totals to the requested date range", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.BRANCH_STAFF, mobile: "+919811122255" });
  const schemeId = createId("scheme");
  const customerId = createId("customer");
  await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId,
    customerId,
    receiptNumber: "RCP-JAN",
    amountPaise: 100000,
    mode: PaymentMode.CASH,
    status: PaymentStatus.SUCCESS,
    source: PaymentSource.STAFF_APP,
    collectedBy: user._id,
    paidAt: new Date("2026-01-15T10:00:00+05:30"),
  });
  await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId,
    customerId,
    receiptNumber: "RCP-FEB",
    amountPaise: 200000,
    mode: PaymentMode.CASH,
    status: PaymentStatus.SUCCESS,
    source: PaymentSource.STAFF_APP,
    collectedBy: user._id,
    paidAt: new Date("2026-02-15T10:00:00+05:30"),
  });
  const { adminCashReport } = await import("../src/services/cash.service.js");
  const january = await adminCashReport({
    auth: { tenantId: tenant._id, id: user._id },
    scope: { tenantId: tenant._id },
    query: { from: "2026-01-01", to: "2026-01-31" },
  });
  assert.equal(january.totals.cashCollected.amountPaise, 100000);
  const february = await adminCashReport({
    auth: { tenantId: tenant._id, id: user._id },
    scope: { tenantId: tenant._id },
    query: { from: "2026-02-01", to: "2026-02-28" },
  });
  assert.equal(february.totals.cashCollected.amountPaise, 200000);
});
