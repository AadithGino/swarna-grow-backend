import test from "node:test";
import assert from "node:assert/strict";
import { PlanTier, RedemptionMode, SchemeStatus, TenantRole } from "../src/constants/enums.js";
import { Scheme, SchemePlan, Tenant } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { enrol } from "../src/services/scheme.service.js";
import { isOneActiveSchemePerCustomerEnforced } from "../src/lib/tenant-enrolment-policy.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

const planBody = (tenantId, code) => ({
  _id: createId("schemePlan"),
  tenantId,
  name: "Policy plan",
  code,
  status: "ACTIVE",
  paymentPattern: "FIXED",
  valueBasis: "CASH",
  durationMonths: 12,
  installmentCount: 12,
  version: 1,
  amountRules: { amountMode: "JEWELLER_FIXED", fixedAmountPaise: 100_000 },
  scheduleRules: { dueDateRule: "JOIN_ANNIVERSARY", firstInstallmentModeDefault: "START_NEXT_CYCLE" },
  paymentRules: { partialPaymentAllowed: false, minPaymentPaise: 100_000 },
  redemptionRules: {
    prematureClosureAllowed: false,
    lockInMonths: 0,
    prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
    allowedModes: [RedemptionMode.CASH],
    redeemAtAnyBranch: false,
  },
  benefit: {
    type: "TEXT_ONLY",
    displayLabel: "Benefit",
    eligibility: { requireAllInstallmentsPaid: true, maxAllowedDefaults: 0, minMonthsCompleted: 0 },
  },
  availability: {
    allBranches: true,
    branchIds: [],
    visibleInCustomerApp: true,
    customerSelfEnrolAllowed: true,
  },
});

function staffReq({ tenant, branch, user, customerId, planId }) {
  return {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    tenant,
    headers: {},
    ip: "127.0.0.1",
    body: {
      customerId,
      planId,
      branchId: branch._id,
      installmentAmountPaise: 100_000,
      firstInstallmentMode: "START_NEXT_CYCLE",
    },
  };
}

async function growthTenant(updates = {}) {
  const seeded = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await Tenant.updateOne(
    { _id: seeded.tenant._id },
    { $set: { "subscription.tier": PlanTier.GROWTH, ...updates } },
  );
  const tenant = await Tenant.findById(seeded.tenant._id).lean();
  return { ...seeded, tenant };
}

test("ops multiSchemePerCustomer false enforces one active scheme", async () => {
  const { tenant, branch, user } = await growthTenant({
    "operations.multiSchemePerCustomer": false,
    "settings.oneActiveSchemePerCustomer": false,
  });
  assert.equal(isOneActiveSchemePerCustomerEnforced(tenant), true);
  const plan = planBody(tenant._id, "OPS1");
  await SchemePlan.create(plan);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await enrol(staffReq({ tenant, branch, user, customerId: customer._id, planId: plan._id }));
  await assert.rejects(
    () => enrol(staffReq({ tenant, branch, user, customerId: customer._id, planId: plan._id })),
    (error) => error.code === "ONE_SCHEME_POLICY",
  );
});

test("legacy oneActiveSchemePerCustomer true enforces policy", async () => {
  const seeded = await growthTenant({
    "settings.oneActiveSchemePerCustomer": true,
  });
  await Tenant.updateOne(
    { _id: seeded.tenant._id },
    { $unset: { "operations.multiSchemePerCustomer": "" } },
  );
  const tenant = await Tenant.findById(seeded.tenant._id).lean();
  const { branch, user } = seeded;
  assert.equal(isOneActiveSchemePerCustomerEnforced(tenant), true);
  const plan = planBody(tenant._id, "LEG1");
  await SchemePlan.create(plan);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await enrol(staffReq({ tenant, branch, user, customerId: customer._id, planId: plan._id }));
  await assert.rejects(
    () => enrol(staffReq({ tenant, branch, user, customerId: customer._id, planId: plan._id })),
    (error) => error.code === "ONE_SCHEME_POLICY",
  );
});

test("neither flag set allows multiple active schemes", async () => {
  const { tenant, branch, user } = await growthTenant({
    "settings.oneActiveSchemePerCustomer": false,
    "operations.multiSchemePerCustomer": true,
  });
  assert.equal(isOneActiveSchemePerCustomerEnforced(tenant), false);
  const planA = planBody(tenant._id, "MUL1");
  const planB = planBody(tenant._id, "MUL2");
  await SchemePlan.insertMany([planA, planB]);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await enrol(staffReq({ tenant, branch, user, customerId: customer._id, planId: planA._id }));
  await enrol(staffReq({ tenant, branch, user, customerId: customer._id, planId: planB._id }));
  assert.equal(
    await Scheme.countDocuments({
      tenantId: tenant._id,
      customerId: customer._id,
      status: SchemeStatus.ACTIVE,
    }),
    2,
  );
});
