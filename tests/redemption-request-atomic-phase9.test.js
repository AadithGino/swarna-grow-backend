import test from "node:test";
import assert from "node:assert/strict";
import { createId } from "../src/lib/ids.js";
import { Customer, LedgerEntry, Redemption, Scheme } from "../src/models/index.js";
import { requestCustomerRedemption } from "../src/services/redemption.service.js";
import {
  LedgerEntryType,
  RedemptionMode,
  RedemptionStatus,
  SchemeStatus,
  TenantRole,
} from "../src/constants/enums.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function seedMatured() {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "Atomic Redemption Customer",
    mobile: `+9188${String(Date.now()).slice(-8)}`,
    kyc: { status: "VERIFIED", type: "PAN", numberMasked: "XXXX1234" },
  });
  const amountPaidPaise = 300_000;
  const installments = [1, 2, 3].map((number) => ({
    number,
    dueDate: `2025-${String(number).padStart(2, "0")}-05`,
    amountPaise: amountPaidPaise / 3,
    paidPaise: amountPaidPaise / 3,
    status: "PAID",
    graceEndsAt: `2025-${String(number).padStart(2, "0")}-10`,
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
      redemptionRules: { allowedModes: [RedemptionMode.CASH], prematureClosureAllowed: false },
      benefit: { type: "TEXT_ONLY", displayLabel: "Gift voucher" },
    },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: SchemeStatus.MATURED,
    startDate: "2025-01-01",
    maturityDate: "2025-12-01",
    installmentAmountPaise: amountPaidPaise / 3,
    installments,
    version: 1,
    createdBy: user._id,
  });
  await LedgerEntry.create({
    _id: createId("ledger"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    type: LedgerEntryType.INSTALLMENT_PAYMENT,
    sequence: 1,
    amountPaise: amountPaidPaise,
    actorType: "USER",
    actorId: user._id,
    description: "Test payments",
  });
  return { customer, scheme };
}

function customerReq({ customer, scheme, expectedVersion = scheme.version }) {
  return {
    auth: { id: customer._id, tenantId: scheme.tenantId, type: "CUSTOMER" },
    scope: { tenantId: scheme.tenantId },
    params: { schemeId: scheme._id },
    body: { preferredMode: RedemptionMode.CASH, expectedVersion },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  };
}

test("concurrent customer redemption requests leave one open redemption", async () => {
  const { customer, scheme } = await seedMatured();
  const req = customerReq({ customer, scheme });
  const results = await Promise.allSettled([
    requestCustomerRedemption(req),
    requestCustomerRedemption(req),
  ]);
  const fulfilled = results.filter((row) => row.status === "fulfilled");
  const rejected = results.filter((row) => row.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "REDEMPTION_ALREADY_OPEN");
  const openCount = await Redemption.countDocuments({
    tenantId: scheme.tenantId,
    schemeId: scheme._id,
    status: { $in: [RedemptionStatus.REQUESTED, RedemptionStatus.PENDING_APPROVAL, RedemptionStatus.APPROVED] },
  });
  assert.equal(openCount, 1);
});

test("stale expectedVersion is rejected inside redemption transaction", async () => {
  const { customer, scheme } = await seedMatured();
  await assert.rejects(
    () => requestCustomerRedemption(customerReq({ customer, scheme, expectedVersion: scheme.version - 1 })),
    (error) => error.code === "VERSION_CONFLICT",
  );
});
