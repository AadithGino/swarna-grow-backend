import test from "node:test";
import assert from "node:assert/strict";
import { createId } from "../src/lib/ids.js";
import { Customer, LedgerEntry, Redemption, Scheme } from "../src/models/index.js";
import {
  requestCustomerRedemption,
  transitionRedemption,
} from "../src/services/redemption.service.js";
import { ledgerTotals } from "../src/services/scheme.service.js";
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

async function seedMaturedScheme({ status = SchemeStatus.MATURED, amountPaidPaise = 300000 } = {}) {
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
    mobile: `+9197${String(Date.now()).slice(-8)}`,
  });
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "Redemption Customer",
    mobile: `+9188${String(Date.now()).slice(-8)}`,
    kyc: { status: "VERIFIED", type: "PAN", numberMasked: "XXXX1234" },
  });
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
    status,
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
  return { tenant, branch, user, customer, scheme, amountPaidPaise };
}

function customerReq({ customer, scheme, body = {} }) {
  return {
    auth: { id: customer._id, tenantId: scheme.tenantId, type: "CUSTOMER" },
    scope: { tenantId: scheme.tenantId },
    params: { schemeId: scheme._id },
    body: {
      preferredMode: RedemptionMode.CASH,
      expectedVersion: scheme.version,
      ...body,
    },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  };
}

function adminReq({ user, scheme, redemptionId, body = {} }) {
  return {
    auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
    scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
    params: { redemptionId, id: redemptionId },
    body,
    query: {},
    headers: {},
    ip: "127.0.0.1",
  };
}

test("customer redemption on non-matured scheme is rejected", async () => {
  const { customer, scheme } = await seedMaturedScheme({ status: SchemeStatus.ACTIVE });
  await assert.rejects(
    () => requestCustomerRedemption(customerReq({ customer, scheme })),
    (error) => error.code === "SCHEME_NOT_MATURED",
  );
});

test("customer redemption on matured scheme stores computed settlement", async () => {
  const { customer, scheme, amountPaidPaise } = await seedMaturedScheme();
  const result = await requestCustomerRedemption(customerReq({ customer, scheme }));
  assert.equal(result.settlementPaise, amountPaidPaise);
  const row = await Redemption.findById(result.id).lean();
  assert.equal(row.settlementPaise, amountPaidPaise);
  assert.equal(row.principalPaise, amountPaidPaise);
  assert.equal(row.benefitPaise, 0);
  assert.ok(row.modeDetails?.settlementSnapshot?.computedAt);
});

test("completing redemption rejects when settlement changed after request", async () => {
  const { customer, scheme, user } = await seedMaturedScheme();
  const requested = await requestCustomerRedemption(customerReq({ customer, scheme }));
  await LedgerEntry.create({
    _id: createId("ledger"),
    tenantId: scheme.tenantId,
    branchId: scheme.branchId,
    schemeId: scheme._id,
    customerId: customer._id,
    type: LedgerEntryType.INSTALLMENT_PAYMENT,
    sequence: 2,
    amountPaise: 50000,
    actorType: "USER",
    actorId: user._id,
    description: "Late payment",
  });
  await transitionRedemption(adminReq({ user, scheme, redemptionId: requested.id, action: "approve" }), "approve");
  await assert.rejects(
    () => transitionRedemption(adminReq({ user, scheme, redemptionId: requested.id, action: "complete" }), "complete"),
    (error) => error.code === "SETTLEMENT_VALUE_CHANGED",
  );
});

test("completed redemption ledger debits match settlement amount", async () => {
  const { customer, scheme, user, amountPaidPaise } = await seedMaturedScheme();
  const requested = await requestCustomerRedemption(customerReq({ customer, scheme }));
  await transitionRedemption(adminReq({ user, scheme, redemptionId: requested.id, action: "approve" }), "approve");
  await transitionRedemption(adminReq({ user, scheme, redemptionId: requested.id, action: "complete" }), "complete");
  const entries = await LedgerEntry.find({ schemeId: scheme._id }).lean();
  const totals = ledgerTotals(entries);
  assert.equal(totals.amountPaidPaise, 0);
  const redemptionDebit = entries.find((row) => row.type === LedgerEntryType.REDEMPTION_DEBIT);
  assert.equal(redemptionDebit.amountPaise, amountPaidPaise);
  const completed = await Redemption.findById(requested.id).lean();
  assert.equal(completed.status, RedemptionStatus.COMPLETED);
  assert.equal(completed.settlementPaise, amountPaidPaise);
});
