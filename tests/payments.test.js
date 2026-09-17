import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/lib/app-error.js";
import { createId } from "../src/lib/ids.js";
import { Customer, LedgerEntry, Payment, Scheme, Tenant } from "../src/models/index.js";
import { recordPayment, reversePayment } from "../src/services/payment.service.js";
import { TenantRole } from "../src/constants/enums.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function seedFixedScheme({ installmentAmounts = [100000, 100000, 100000] } = {}) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER, mobile: `+9197${String(Date.now()).slice(-8)}` });
  const customer = await Customer.create({
    _id: createId("customer"), tenantId: tenant._id, branchId: branch._id, customerNumber: `C${Date.now()}`, name: "Fixed Customer", mobile: `+9188${String(Date.now()).slice(-8)}`,
  });
  const installments = installmentAmounts.map((amountPaise, index) => ({
    number: index + 1,
    dueDate: `2026-${String(index + 1).padStart(2, "0")}-05`,
    amountPaise,
    paidPaise: 0,
    status: index === 0 ? "DUE" : "PENDING",
    graceEndsAt: `2026-${String(index + 1).padStart(2, "0")}-10`,
  }));
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      paymentRules: { partialPaymentAllowed: true, advancePaymentAllowed: false, maxAdvanceInstallments: 0, minPaymentPaise: 1000 },
    },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installmentAmountPaise: installmentAmounts[0],
    installments,
    version: 1,
    createdBy: user._id,
  });
  return { tenant, branch, user, customer, scheme };
}

function paymentReq({ scheme, user, amountPaise, mode = "CASH", expectedVersion }) {
  return {
    auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
    scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
    baseUrl: "/api/v1/admin",
    headers: { "user-agent": "payments-test" },
    ip: "127.0.0.1",
    body: { schemeId: scheme._id, amountPaise, mode, expectedVersion },
    query: {},
  };
}

test("fixed scheme allocates oldest due installment first", async () => {
  const { scheme, user } = await seedFixedScheme();
  await recordPayment(paymentReq({ scheme, user, amountPaise: 100000, expectedVersion: 1 }));
  const refreshed = await Scheme.findById(scheme._id).lean();
  assert.equal(refreshed.installments[0].status, "PAID");
  assert.equal(refreshed.installments[0].paidPaise, 100000);
  assert.equal(refreshed.installments[1].status, "PENDING");
  assert.equal(refreshed.installments[1].paidPaise, 0);
});

test("overpayment above max payable is blocked", async () => {
  const { scheme, user } = await seedFixedScheme({ installmentAmounts: [50000] });
  await assert.rejects(
    () => recordPayment(paymentReq({ scheme, user, amountPaise: 60000, expectedVersion: 1 })),
    (error) => error.code === "AMOUNT_ABOVE_MAXIMUM",
  );
});

test("ONLINE_GATEWAY cannot be recorded on the manual payment path", async () => {
  const { scheme, user } = await seedFixedScheme();
  await assert.rejects(
    () => recordPayment(paymentReq({ scheme, user, amountPaise: 100000, mode: "ONLINE_GATEWAY", expectedVersion: 1 })),
    (error) => error instanceof AppError && error.code === "MANUAL_GATEWAY_PAYMENT_NOT_ALLOWED",
  );
});

test("reversal appends a ledger entry rather than mutating the original payment amount", async () => {
  const { scheme, user } = await seedFixedScheme();
  const payment = await recordPayment(paymentReq({ scheme, user, amountPaise: 100000, expectedVersion: 1 }));
  const before = await LedgerEntry.find({ schemeId: scheme._id }).sort({ sequence: 1 }).lean();
  assert.equal(before.length, 1);
  assert.equal(before[0].type, "INSTALLMENT_PAYMENT");
  await reversePayment({
    auth: { id: user._id, tenantId: scheme.tenantId },
    scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
    params: { paymentId: payment._id },
    body: { reason: "Duplicate entry" },
    headers: { "user-agent": "payments-test" },
    ip: "127.0.0.1",
  });
  const after = await LedgerEntry.find({ schemeId: scheme._id }).sort({ sequence: 1 }).lean();
  assert.equal(after.length, 2);
  assert.equal(after[0].type, "INSTALLMENT_PAYMENT");
  assert.equal(after[0].amountPaise, 100000);
  assert.equal(after[1].type, "REVERSAL");
  assert.equal(after[1].amountPaise, 100000);
  assert.equal(after[1].reversalOf, payment._id);
});

test("reversal is blocked after tenant paymentReversalWindowHours", async () => {
  const { tenant, scheme, user } = await seedFixedScheme();
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "operations.paymentReversalWindowHours": 24 } },
  );
  const payment = await recordPayment(paymentReq({ scheme, user, amountPaise: 100000, expectedVersion: 1 }));
  const stalePaidAt = new Date(Date.now() - 25 * 3_600_000);
  await Payment.updateOne({ _id: payment._id }, { $set: { paidAt: stalePaidAt } });
  await assert.rejects(
    () => reversePayment({
      auth: { id: user._id, tenantId: scheme.tenantId },
      scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
      params: { paymentId: payment._id },
      body: { reason: "Too late" },
      headers: { "user-agent": "payments-test" },
      ip: "127.0.0.1",
    }),
    (error) => error instanceof AppError && error.code === "REVERSAL_WINDOW_EXPIRED",
  );
});
