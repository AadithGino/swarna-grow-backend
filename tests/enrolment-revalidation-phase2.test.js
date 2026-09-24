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
import {
  Customer,
  LedgerEntry,
  OutboxEvent,
  Payment,
  PaymentIntent,
  PaymentLink,
  Scheme,
  SchemePlan,
  Tenant,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { today, addMonthsClamped } from "../src/lib/date.js";
import { withTransaction } from "../src/lib/transaction.js";
import {
  createEnrolmentInSession,
  enrol,
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

async function snapshotTenant(tenantId) {
  return {
    schemes: await Scheme.countDocuments({ tenantId }),
    payments: await Payment.countDocuments({ tenantId }),
    intents: await PaymentIntent.countDocuments({ tenantId }),
    links: await PaymentLink.countDocuments({ tenantId }),
    ledgers: await LedgerEntry.countDocuments({ tenantId }),
    joinedEvents: await OutboxEvent.countDocuments({ tenantId, topic: "scheme.joined" }),
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
      firstInstallmentMode: FirstInstallmentMode.START_NEXT_CYCLE,
      ...body,
    },
  };
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

async function growthTenant() {
  const seeded = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await Tenant.updateOne(
    { _id: seeded.tenant._id },
    { $set: { "subscription.tier": PlanTier.GROWTH } },
  );
  const tenant = await Tenant.findById(seeded.tenant._id).lean();
  return { ...seeded, tenant };
}

async function rejectEnrolmentAfterPlanChange({
  mutatePlan,
  expectedCode,
  reqFactory,
}) {
  const { tenant, branch, user } = await growthTenant();
  const plan = buildPlan(tenant._id, "REVAL");
  await SchemePlan.create(plan);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const req = reqFactory({ tenant, branch, user, customer, plan });
  const validation = await validateEnrolment(req);
  await mutatePlan(plan._id, { tenant, branch, customer, user });
  const before = await snapshotTenant(tenant._id);
  await assert.rejects(
    () => withTransaction((session) => createEnrolmentInSession(req, validation, session)),
    (error) => error.code === expectedCode,
  );
  const after = await snapshotTenant(tenant._id);
  assert.deepEqual(after, before);
}

test("revalidation rejects inactive plan with no persisted enrolment artifacts", async () => {
  await rejectEnrolmentAfterPlanChange({
    expectedCode: "PLAN_ENROLMENT_CLOSED",
    reqFactory: ({ tenant, branch, user, customer, plan }) =>
      staffReq({ tenant, branch, user, customerId: customer._id, planId: plan._id }),
    mutatePlan: async (planId) => {
      await SchemePlan.updateOne({ _id: planId }, { $set: { status: SchemePlanStatus.INACTIVE } });
    },
  });
});

test("revalidation rejects future enrolment open date", async () => {
  const future = addMonthsClamped(today(), 2).format("YYYY-MM-DD");
  await rejectEnrolmentAfterPlanChange({
    expectedCode: "PLAN_ENROLMENT_NOT_OPEN",
    reqFactory: ({ tenant, branch, user, customer, plan }) =>
      staffReq({ tenant, branch, user, customerId: customer._id, planId: plan._id }),
    mutatePlan: async (planId) => {
      await SchemePlan.updateOne(
        { _id: planId },
        { $set: { "availability.enrolmentOpenFrom": future } },
      );
    },
  });
});

test("revalidation rejects past enrolment close date", async () => {
  const past = addMonthsClamped(today(), -2).format("YYYY-MM-DD");
  await rejectEnrolmentAfterPlanChange({
    expectedCode: "PLAN_ENROLMENT_CLOSED",
    reqFactory: ({ tenant, branch, user, customer, plan }) =>
      staffReq({ tenant, branch, user, customerId: customer._id, planId: plan._id }),
    mutatePlan: async (planId) => {
      await SchemePlan.updateOne(
        { _id: planId },
        { $set: { "availability.enrolmentOpenTo": past } },
      );
    },
  });
});

test("revalidation rejects branch no longer allowed on plan", async () => {
  await rejectEnrolmentAfterPlanChange({
    expectedCode: "PLAN_NOT_AVAILABLE_AT_BRANCH",
    reqFactory: ({ tenant, branch, user, customer, plan }) =>
      staffReq({ tenant, branch, user, customerId: customer._id, planId: plan._id }),
    mutatePlan: async (planId, { tenant }) => {
      const other = await seedBranch({ tenantId: tenant._id, code: "OTH" });
      await SchemePlan.updateOne(
        { _id: planId },
        { $set: { "availability.allBranches": false, "availability.branchIds": [other._id] } },
      );
    },
  });
});

test("revalidation rejects customer self-enrol when plan disables it", async () => {
  await rejectEnrolmentAfterPlanChange({
    expectedCode: "PLAN_SELF_ENROL_DISABLED",
    reqFactory: ({ tenant, customer, plan }) =>
      customerReq({ tenant, customerId: customer._id, planId: plan._id }),
    mutatePlan: async (planId) => {
      await SchemePlan.updateOne(
        { _id: planId },
        { $set: { "availability.customerSelfEnrolAllowed": false } },
      );
    },
  });
});

test("staff enrolment succeeds when customerSelfEnrolAllowed is false", async () => {
  const { tenant, branch, user } = await growthTenant();
  const plan = buildPlan(tenant._id, "STAFFOK", {
    availability: {
      allBranches: true,
      branchIds: [],
      visibleInCustomerApp: true,
      customerSelfEnrolAllowed: false,
    },
  });
  await SchemePlan.create(plan);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const created = await enrol(staffReq({
    tenant, branch, user, customerId: customer._id, planId: plan._id,
  }));
  assert.ok(created._id);
});

test("revalidation rejects changed plan financial amount", async () => {
  await rejectEnrolmentAfterPlanChange({
    expectedCode: "INVALID_INSTALLMENT_AMOUNT",
    reqFactory: ({ tenant, branch, user, customer, plan }) =>
      staffReq({ tenant, branch, user, customerId: customer._id, planId: plan._id }),
    mutatePlan: async (planId) => {
      await SchemePlan.updateOne(
        { _id: planId },
        { $set: { "amountRules.fixedAmountPaise": 200_000 } },
      );
    },
  });
});

test("revalidation rejects when plan capacity is full", async () => {
  await rejectEnrolmentAfterPlanChange({
    expectedCode: "PLAN_ENROLMENT_LIMIT_REACHED",
    reqFactory: ({ tenant, branch, user, customer, plan }) =>
      staffReq({ tenant, branch, user, customerId: customer._id, planId: plan._id }),
    mutatePlan: async (planId, { tenant, branch }) => {
      const occupier = await seedCustomer({
        tenantId: tenant._id,
        branchId: branch._id,
        mobile: `+9171${String(Date.now()).slice(-8)}`,
      });
      await SchemePlan.updateOne(
        { _id: planId },
        { $set: { "availability.maxEnrolments": 1 } },
      );
      await Scheme.create({
        _id: createId("scheme"),
        tenantId: tenant._id,
        branchId: branch._id,
        customerId: occupier._id,
        planId,
        enrollmentNumber: "ENR-OCCUPY1",
        planSnapshot: { paymentPattern: "FIXED" },
        valueBasis: "CASH",
        paymentPattern: "FIXED",
        status: SchemeStatus.ACTIVE,
        startDate: today(),
        maturityDate: addMonthsClamped(today(), 12).format("YYYY-MM-DD"),
        installmentAmountPaise: 100_000,
        version: 1,
      });
    },
  });
});

test("one-active policy bumps enrolmentSerializationVersion not profile version", async () => {
  const seeded = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await Tenant.updateOne(
    { _id: seeded.tenant._id },
    {
      $set: {
        "settings.oneActiveSchemePerCustomer": true,
        "operations.multiSchemePerCustomer": false,
        "subscription.tier": PlanTier.GROWTH,
      },
    },
  );
  const tenant = await Tenant.findById(seeded.tenant._id).lean();
  const plan = buildPlan(tenant._id, "SERVER");
  await SchemePlan.create(plan);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: seeded.branch._id });
  const before = await Customer.findById(customer._id).lean();
  await enrol(staffReq({
    tenant,
    branch: seeded.branch,
    user: seeded.user,
    customerId: customer._id,
    planId: plan._id,
  }));
  const after = await Customer.findById(customer._id).lean();
  assert.equal(after.version, before.version);
  assert.equal(after.enrolmentSerializationVersion, (before.enrolmentSerializationVersion ?? 0) + 1);
});

test("policy-disabled enrolment does not mutate enrolmentSerializationVersion", async () => {
  const seeded = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await Tenant.updateOne(
    { _id: seeded.tenant._id },
    {
      $set: {
        "settings.oneActiveSchemePerCustomer": false,
        "operations.multiSchemePerCustomer": true,
      },
    },
  );
  const tenant = await Tenant.findById(seeded.tenant._id).lean();
  const plan = buildPlan(tenant._id, "NOSER");
  await SchemePlan.create(plan);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: seeded.branch._id });
  const before = await Customer.findById(customer._id).lean();
  await enrol(staffReq({
    tenant,
    branch: seeded.branch,
    user: seeded.user,
    customerId: customer._id,
    planId: plan._id,
  }));
  const after = await Customer.findById(customer._id).lean();
  assert.equal(after.version, before.version);
  assert.equal(after.enrolmentSerializationVersion ?? 0, before.enrolmentSerializationVersion ?? 0);
});
