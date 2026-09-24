import test from "node:test";
import assert from "node:assert/strict";
import { createId } from "../src/lib/ids.js";
import { isKycRequiredForRedemption } from "../src/lib/kyc-policy.js";
import { Customer, LedgerEntry, Redemption, Scheme, Tenant } from "../src/models/index.js";
import {
  requestCustomerRedemption,
  transitionRedemption,
} from "../src/services/redemption.service.js";
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

async function seedMatured({ kycStatus = "VERIFIED", tenantPatch = {}, policyOn = false } = {}) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const policyPatch = policyOn
    ? { "settings.requireKycForRedemption": true, "operations.requireKycForRedemption": true }
    : {};
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { ...policyPatch, ...tenantPatch } },
  );
  const tenantRow = await Tenant.findById(tenant._id).lean();
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "KYC Redemption Customer",
    mobile: `+9188${String(Date.now()).slice(-8)}`,
    kyc: kycStatus ? { status: kycStatus, type: "PAN", numberMasked: "XXXX1234" } : undefined,
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
  return { tenant: tenantRow, branch, user, customer, scheme };
}

function customerReq({ customer, scheme }) {
  return {
    auth: { id: customer._id, tenantId: scheme.tenantId, type: "CUSTOMER" },
    tenant: undefined,
    scope: { tenantId: scheme.tenantId },
    params: { schemeId: scheme._id },
    body: { preferredMode: RedemptionMode.CASH, expectedVersion: scheme.version },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  };
}

test("default tenant — redemption KYC off; non-verified customer can request", async () => {
  const { tenant, customer, scheme } = await seedMatured({ kycStatus: "NOT_SUBMITTED" });
  assert.equal(isKycRequiredForRedemption(tenant), false);
  const result = await requestCustomerRedemption(customerReq({ customer, scheme }));
  assert.ok(result.id);
});

test("redemption request blocked when KYC policy requires verified customer", async () => {
  const { customer, scheme } = await seedMatured({ kycStatus: "NOT_SUBMITTED", policyOn: true });
  await assert.rejects(
    () => requestCustomerRedemption(customerReq({ customer, scheme })),
    (error) => error.code === "KYC_REQUIRED",
  );
});

test("verified customer can request redemption when KYC policy is on", async () => {
  const { customer, scheme } = await seedMatured({ kycStatus: "VERIFIED", policyOn: true });
  const result = await requestCustomerRedemption(customerReq({ customer, scheme }));
  assert.ok(result.id);
});

test("legacy settings.requireKycForRedemption true enforces KYC", async () => {
  const { tenant, customer, scheme } = await seedMatured({
    kycStatus: "NOT_SUBMITTED",
    tenantPatch: { "settings.requireKycForRedemption": true },
  });
  await Tenant.updateOne(
    { _id: tenant._id },
    { $unset: { "operations.requireKycForRedemption": "" } },
  );
  const refreshed = await Tenant.findById(tenant._id).lean();
  assert.equal(isKycRequiredForRedemption(refreshed), true);
  await assert.rejects(
    () => requestCustomerRedemption(customerReq({ customer, scheme })),
    (error) => error.code === "KYC_REQUIRED",
  );
});

test("operations.requireKycForRedemption false overrides legacy settings true", async () => {
  const { tenant, customer, scheme } = await seedMatured({
    kycStatus: "NOT_SUBMITTED",
    tenantPatch: {
      "settings.requireKycForRedemption": true,
      "operations.requireKycForRedemption": false,
    },
  });
  const refreshed = await Tenant.findById(tenant._id).lean();
  assert.equal(isKycRequiredForRedemption(refreshed), false);
  const result = await requestCustomerRedemption(customerReq({ customer, scheme }));
  assert.ok(result.id);
});

test("completion re-checks KYC when policy is on", async () => {
  const { customer, scheme, user } = await seedMatured({ kycStatus: "VERIFIED", policyOn: true });
  const requested = await requestCustomerRedemption(customerReq({ customer, scheme }));
  await Redemption.updateOne(
    { _id: requested.id },
    { $set: { status: RedemptionStatus.APPROVED } },
  );
  await Customer.updateOne({ _id: customer._id }, { $set: { "kyc.status": "NOT_SUBMITTED" } });
  await assert.rejects(
    () => transitionRedemption({
      auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
      scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
      params: { redemptionId: requested.id, id: requested.id },
      body: {},
      query: {},
      headers: {},
      ip: "127.0.0.1",
    }, "complete"),
    (error) => error.code === "KYC_REQUIRED",
  );
});
