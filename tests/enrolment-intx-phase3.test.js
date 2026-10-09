import test from "node:test";
import assert from "node:assert/strict";
import {
  FirstInstallmentMode,
  PlanTier,
  RedemptionMode,
  SchemePlanStatus,
  SchemeStatus,
  TenantRole,
} from "../src/constants/enums.js";
import { Customer, PaymentIntent, PaymentLink, Scheme, SchemePlan, Tenant } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { withTransaction } from "../src/lib/transaction.js";
import {
  createEnrolmentInSession,
  customerEnrolWithCheckout,
  validateEnrolment,
} from "../src/services/scheme.service.js";
import { seedBranch, seedCustomer, seedTenantUser, startTestDb, stopTestDb, resetTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

const redemptionRules = {
  prematureClosureAllowed: false,
  lockInMonths: 0,
  prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
  allowedModes: [RedemptionMode.CASH],
  redeemAtAnyBranch: false,
};

const benefit = {
  type: "TEXT_ONLY",
  displayLabel: "Benefit",
  eligibility: {
    requireAllInstallmentsPaid: true,
    maxAllowedDefaults: 0,
    minMonthsCompleted: 0,
  },
};

function buildPlan(tenantId, code, overrides = {}) {
  return {
    _id: createId("schemePlan"),
    tenantId,
    name: `Plan ${code}`,
    code,
    status: SchemePlanStatus.ACTIVE,
    paymentPattern: "FIXED",
    valueBasis: "CASH",
    durationMonths: 12,
    installmentCount: 12,
    version: 1,
    amountRules: { amountMode: "JEWELLER_FIXED", fixedAmountPaise: 100_000 },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      firstInstallmentModeDefault: FirstInstallmentMode.START_NEXT_CYCLE,
      firstInstallmentModeEditable: true,
    },
    paymentRules: { partialPaymentAllowed: false, minPaymentPaise: 100_000 },
    redemptionRules,
    benefit,
    availability: {
      allBranches: true,
      branchIds: [],
      visibleInCustomerApp: true,
      customerSelfEnrolAllowed: true,
    },
    ...overrides,
  };
}

function staffReq({ tenant, branch, user, customerId, planId, body = {} }) {
  return {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    tenant,
    headers: {},
    ip: "127.0.0.1",
    baseUrl: "/admin",
    body: {
      customerId,
      planId,
      branchId: branch._id,
      installmentAmountPaise: 100_000,
      firstInstallmentMode: FirstInstallmentMode.COLLECT_NOW,
      ...body,
    },
  };
}

async function growthTenant() {
  const seeded = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await Tenant.updateOne(
    { _id: seeded.tenant._id },
    { $set: { "subscription.tier": PlanTier.GROWTH } },
  );
  const tenant = await Tenant.findById(seeded.tenant._id).lean();
  return { ...seeded, tenant };
}

function customerReq({ tenant, customerId, planId, body = {} }) {
  return {
    auth: { id: customerId, tenantId: tenant._id, type: "CUSTOMER" },
    scope: { tenantId: tenant._id },
    tenant,
    headers: {},
    ip: "127.0.0.1",
    baseUrl: "/app",
    body: {
      planId,
      installmentAmountPaise: 100_000,
      payNow: false,
      ...body,
    },
  };
}

test("in-tx customer self-enrol uses updated customer branch after pre-tx validation", async () => {
  const { tenant, branch } = await growthTenant();
  const otherBranch = await seedBranch({ tenantId: tenant._id, code: "MOV" });
  const plan = buildPlan(tenant._id, "BRMOVE");
  await SchemePlan.create(plan);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const req = customerReq({ tenant, customerId: customer._id, planId: plan._id });
  const validation = await validateEnrolment(req);
  assert.equal(validation.branchId, branch._id);
  await Customer.updateOne({ _id: customer._id }, { $set: { branchId: otherBranch._id } });
  const scheme = await withTransaction((session) =>
    createEnrolmentInSession(req, validation, session),
  );
  assert.equal(scheme.branchId, otherBranch._id);
  assert.equal(scheme.status, SchemeStatus.ACTIVE);
});

test("in-tx enrolment rejects when KYC is revoked before commit", async () => {
  const { tenant, branch, user } = await growthTenant();
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "settings.requireKycForEnrolment": true } },
  );
  const tenantWithKyc = await Tenant.findById(tenant._id).lean();
  const plan = buildPlan(tenant._id, "KYCX");
  await SchemePlan.create(plan);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await Customer.updateOne(
    { _id: customer._id },
    { $set: { kyc: { status: "VERIFIED", type: "PAN", numberMasked: "XXXX1234" } } },
  );
  const req = staffReq({
    tenant: tenantWithKyc,
    branch,
    user,
    customerId: customer._id,
    planId: plan._id,
  });
  const validation = await validateEnrolment(req);
  await Customer.updateOne({ _id: customer._id }, { $set: { "kyc.status": "PENDING" } });
  await assert.rejects(
    () => withTransaction((session) => createEnrolmentInSession(req, validation, session)),
    (error) => error.code === "KYC_REQUIRED",
  );
  assert.equal(await Scheme.countDocuments({ tenantId: tenant._id }), 0);
});

test("in-tx enrolment derives PENDING_PAYMENT from locked firstInstallmentMode", async () => {
  const { tenant, branch, user } = await growthTenant();
  const plan = buildPlan(tenant._id, "PAY1", {
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      firstInstallmentModeDefault: FirstInstallmentMode.START_NEXT_CYCLE,
      firstInstallmentModeEditable: false,
    },
  });
  await SchemePlan.create(plan);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const req = staffReq({
    tenant,
    branch,
    user,
    customerId: customer._id,
    planId: plan._id,
    body: { firstInstallmentMode: FirstInstallmentMode.COLLECT_NOW },
  });
  const validation = await validateEnrolment(req);
  assert.equal(validation.firstInstallmentRequired, false);
  const scheme = await withTransaction((session) =>
    createEnrolmentInSession(req, validation, session),
  );
  assert.equal(scheme.status, SchemeStatus.ACTIVE);
  assert.equal(scheme.firstInstallmentRequired, false);
});

test("in-tx plan flip to COLLECT_NOW aligns status and response firstInstallmentRequired", async () => {
  const { tenant, branch, user } = await growthTenant();
  const plan = buildPlan(tenant._id, "FLIP1", {
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      firstInstallmentModeDefault: FirstInstallmentMode.START_NEXT_CYCLE,
      firstInstallmentModeEditable: false,
    },
  });
  await SchemePlan.create(plan);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const req = staffReq({
    tenant,
    branch,
    user,
    customerId: customer._id,
    planId: plan._id,
  });
  const validation = await validateEnrolment(req);
  assert.equal(validation.firstInstallmentRequired, false);
  await SchemePlan.updateOne(
    { _id: plan._id },
    {
      $set: {
        "scheduleRules.firstInstallmentModeDefault": FirstInstallmentMode.COLLECT_NOW,
      },
      $inc: { version: 1 },
    },
  );
  const scheme = await withTransaction((session) =>
    createEnrolmentInSession(req, validation, session),
  );
  assert.equal(scheme.status, SchemeStatus.PENDING_PAYMENT);
  assert.equal(scheme.firstInstallmentRequired, true);
});

test("in-tx plan flip to START_NEXT_CYCLE avoids checkout when pre-tx required first payment", async () => {
  const { tenant, branch } = await growthTenant();
  const plan = buildPlan(tenant._id, "FLIP2", {
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      firstInstallmentModeDefault: FirstInstallmentMode.COLLECT_NOW,
      firstInstallmentModeEditable: false,
    },
  });
  await SchemePlan.create(plan);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const req = {
    ...customerReq({ tenant, customerId: customer._id, planId: plan._id }),
    body: {
      planId: plan._id,
      installmentAmountPaise: 100_000,
      redirectUrl: "http://localhost:5173/pay/return",
    },
  };
  const preTx = await validateEnrolment(req);
  assert.equal(preTx.firstInstallmentRequired, true);
  await SchemePlan.updateOne(
    { _id: plan._id },
    {
      $set: {
        "scheduleRules.firstInstallmentModeDefault": FirstInstallmentMode.START_NEXT_CYCLE,
      },
      $inc: { version: 1 },
    },
  );
  const { enrolled, checkout } = await customerEnrolWithCheckout(req);
  assert.equal(enrolled.status, SchemeStatus.ACTIVE);
  assert.equal(enrolled.firstInstallmentRequired, false);
  assert.equal(checkout, null);
  assert.equal(await PaymentIntent.countDocuments({ tenantId: tenant._id, customerId: customer._id }), 0);
  assert.equal(await PaymentLink.countDocuments({ tenantId: tenant._id, customerId: customer._id }), 0);
});
