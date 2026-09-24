import test from "node:test";
import assert from "node:assert/strict";
import { planBody, goldRateBody } from "../src/validators/common.validators.js";
import { RedemptionMode, PlanTier, TenantRole } from "../src/constants/enums.js";
import { Branch, SchemePlan, Tenant } from "../src/models/index.js";
import { createPlan, updatePlan } from "../src/services/plan.service.js";
import { AppError } from "../src/lib/app-error.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

const planBase = {
  name: "Satisfiability plan",
  code: "SATPLAN1",
  valueBasis: "CASH",
  paymentPattern: "FIXED",
  durationMonths: 12,
  installmentCount: 12,
  amountRules: { amountMode: "JEWELLER_FIXED", fixedAmountPaise: 100_000 },
  scheduleRules: {
    dueDateRule: "FIXED_DAY_OF_MONTH",
    dueDayOfMonth: 5,
    firstInstallmentModeDefault: "START_NEXT_CYCLE",
  },
  paymentRules: { partialPaymentAllowed: false, minPaymentPaise: 100_000 },
  redemptionRules: {
    prematureClosureAllowed: false,
    lockInMonths: 0,
    prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
    allowedModes: [RedemptionMode.CASH],
    redeemAtAnyBranch: false,
  },
  availability: {
    allBranches: true,
    branchIds: [],
    visibleInCustomerApp: true,
    customerSelfEnrolAllowed: true,
  },
  benefit: {
    type: "TEXT_ONLY",
    displayLabel: "Gift voucher",
    eligibility: {
      requireAllInstallmentsPaid: true,
      maxAllowedDefaults: 0,
      minMonthsCompleted: 0,
    },
  },
};

function flexPlan(overrides = {}) {
  return {
    ...planBase,
    code: overrides.code ?? "SATFLEX1",
    paymentPattern: "FLEXIBLE",
    amountRules: {
      amountMode: "CUSTOMER_CHOSEN",
      minInstallmentPaise: 10_000,
      maxInstallmentPaise: 500_000,
      multipleOfPaise: 1_000,
    },
    scheduleRules: { dueDateRule: "JOIN_ANNIVERSARY", firstInstallmentModeDefault: "COLLECT_NOW" },
    paymentRules: { partialPaymentAllowed: true, minPaymentPaise: 10_000 },
    flexibleRules: {
      phaseMode: "FLEXIBLE_THEN_CAPPED",
      capMode: "FLEXIBLE_PHASE_AVERAGE",
      carryForwardMode: "NONE",
      flexiblePhaseCycles: 6,
      cappedPhaseCycles: 6,
      averagingDivisor: 6,
      frequencyMode: "MULTIPLE",
      flexiblePhase: {
        minimumPaymentPaise: 10_000,
        maximumPaymentPaise: 500_000,
        paymentIncrementPaise: 1_000,
        minTotalPaise: 0,
        paymentsRequiredPerCycle: 0,
      },
      capComputation: {
        formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
        roundingMode: "ROUND_UP",
        roundToNearestPaise: 10_000,
        minCycleCapPaise: 50_000,
        maxCycleCapPaise: 10_000_000,
        onZeroFlexiblePhaseTotal: "CLOSE_SCHEME",
        onBelowMinimumTotal: "USE_MINIMUM",
      },
      cappedPhase: {
        minimumPaymentPaise: 10_000,
        paymentIncrementPaise: 1_000,
        allowFinalRemainderBelowMinimum: true,
        allowFutureCyclePayment: false,
        maxAdvanceCycles: 0,
      },
    },
    ...overrides,
  };
}

test("valid fixed plan passes satisfiability validation", () => {
  const parsed = planBody.safeParse(planBase);
  assert.equal(parsed.success, true);
});

test("customer range with no multipleOf-compatible amount is rejected", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "SATRNG1",
    amountRules: {
      amountMode: "CUSTOMER_CHOSEN",
      minInstallmentPaise: 15_050,
      maxInstallmentPaise: 15_400,
      multipleOfPaise: 1_000,
    },
    paymentRules: { partialPaymentAllowed: true, minPaymentPaise: 10_000 },
  });
  assert.equal(parsed.success, false);
});

test("no-partial fixed installment above max txn is rejected", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "SATFIX1",
    paymentRules: {
      partialPaymentAllowed: false,
      minPaymentPaise: 100_000,
      maxPaymentPerTransactionPaise: 50_000,
    },
  });
  assert.equal(parsed.success, false);
});

test("flexible phase with no increment-compatible payment is rejected", () => {
  const body = flexPlan({
    code: "SATINC1",
    flexibleRules: {
      ...flexPlan().flexibleRules,
      flexiblePhase: {
        minimumPaymentPaise: 15_050,
        maximumPaymentPaise: 15_400,
        paymentIncrementPaise: 1_000,
      },
    },
  });
  const parsed = planBody.safeParse(body);
  assert.equal(parsed.success, false);
});

test("capped minimum payment above max cycle cap is rejected", () => {
  const body = flexPlan({
    code: "SATCAP1",
    flexibleRules: {
      ...flexPlan().flexibleRules,
      capComputation: {
        ...flexPlan().flexibleRules.capComputation,
        maxCycleCapPaise: 20_000,
      },
      cappedPhase: {
        ...flexPlan().flexibleRules.cappedPhase,
        minimumPaymentPaise: 50_000,
      },
    },
  });
  const parsed = planBody.safeParse(body);
  assert.equal(parsed.success, false);
});

test("capped min>minCycleCap with finalRemainder false is rejected", () => {
  const body = flexPlan({
    code: "SATCAP2",
    flexibleRules: {
      ...flexPlan().flexibleRules,
      capComputation: {
        ...flexPlan().flexibleRules.capComputation,
        minCycleCapPaise: 20_000,
        maxCycleCapPaise: 10_000_000,
      },
      cappedPhase: {
        ...flexPlan().flexibleRules.cappedPhase,
        minimumPaymentPaise: 50_000,
        allowFinalRemainderBelowMinimum: false,
      },
    },
  });
  const parsed = planBody.safeParse(body);
  assert.equal(parsed.success, false);
});

test("capped min>minCycleCap with finalRemainder true is accepted", () => {
  const body = flexPlan({
    code: "SATCAP3",
    flexibleRules: {
      ...flexPlan().flexibleRules,
      capComputation: {
        ...flexPlan().flexibleRules.capComputation,
        minCycleCapPaise: 20_000,
        maxCycleCapPaise: 10_000_000,
      },
      cappedPhase: {
        ...flexPlan().flexibleRules.cappedPhase,
        minimumPaymentPaise: 50_000,
        allowFinalRemainderBelowMinimum: true,
      },
    },
  });
  const parsed = planBody.safeParse(body);
  assert.equal(parsed.success, true);
});

test("benefit minMonthsCompleted above durationMonths is rejected", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "SATBEN1",
    benefit: {
      ...planBase.benefit,
      eligibility: { ...planBase.benefit.eligibility, minMonthsCompleted: 24 },
    },
  });
  assert.equal(parsed.success, false);
});

test("benefit maxAllowedDefaults above installmentCount is rejected", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "SATBEN2",
    benefit: {
      ...planBase.benefit,
      eligibility: { ...planBase.benefit.eligibility, maxAllowedDefaults: 20 },
    },
  });
  assert.equal(parsed.success, false);
});

test("duplicate slab amounts are rejected", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "SATSLB1",
    amountRules: {
      amountMode: "JEWELLER_SLABS",
      slabsPaise: [50_000, 50_000],
    },
    paymentRules: { partialPaymentAllowed: true, minPaymentPaise: 10_000, maxPaymentPerTransactionPaise: 100_000 },
  });
  assert.equal(parsed.success, false);
});

test("invalid enrolment calendar dates are rejected", () => {
  const feb30 = planBody.safeParse({
    ...planBase,
    code: "SATDT1",
    availability: { ...planBase.availability, enrolmentOpenFrom: "2026-02-30" },
  });
  assert.equal(feb30.success, false);
  const month13 = planBody.safeParse({
    ...planBase,
    code: "SATDT2",
    availability: { ...planBase.availability, enrolmentOpenTo: "2026-13-01" },
  });
  assert.equal(month13.success, false);
});

test("gold rate effectiveDate rejects invalid calendar day", () => {
  const parsed = goldRateBody.safeParse({
    effectiveDate: "2026-99-99",
    ratePerGramPaise: 500_000,
  });
  assert.equal(parsed.success, false);
});

test("createPlan rejects branchIds outside tenant", async () => {
  const { tenant, user, branch } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await Tenant.updateOne({ _id: tenant._id }, { $set: { "subscription.tier": PlanTier.GROWTH } });
  const otherBranchId = createId("branch");
  await Branch.create({
    _id: otherBranchId,
    tenantId: createId("tenant"),
    name: "Other",
    code: "OTH",
    active: true,
  });
  const tenantRow = await Tenant.findById(tenant._id).lean();
  await assert.rejects(
    () => createPlan({
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
      tenant: tenantRow,
      headers: { "user-agent": "test" },
      ip: "127.0.0.1",
      body: {
        ...planBase,
        code: "SATBR1",
        availability: { ...planBase.availability, allBranches: false, branchIds: [otherBranchId] },
      },
    }),
    (error) => error instanceof AppError && error.code === "VALIDATION_FAILED",
  );
  assert.equal(await SchemePlan.countDocuments({ tenantId: tenant._id }), 0);
  assert.ok(branch._id);
});

test("updatePlan PATCH merge into unsatisfiable plan is rejected", async () => {
  const { tenant, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await Tenant.updateOne({ _id: tenant._id }, { $set: { "subscription.tier": PlanTier.GROWTH } });
  const tenantRow = await Tenant.findById(tenant._id).lean();
  const created = await createPlan({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    tenant: tenantRow,
    headers: { "user-agent": "test" },
    ip: "127.0.0.1",
    body: {
      ...planBase,
      code: "SATPATCH",
      amountRules: {
        amountMode: "CUSTOMER_CHOSEN",
        minInstallmentPaise: 10_000,
        maxInstallmentPaise: 500_000,
        multipleOfPaise: 1_000,
      },
      paymentRules: { partialPaymentAllowed: true, minPaymentPaise: 10_000 },
    },
  });
  await assert.rejects(
    () => updatePlan({
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
      tenant: tenantRow,
      params: { planId: created._id },
      headers: { "user-agent": "test" },
      ip: "127.0.0.1",
      body: {
        expectedVersion: created.version,
        amountRules: {
          minInstallmentPaise: 15_050,
          maxInstallmentPaise: 15_400,
        },
      },
    }),
    (error) => error instanceof AppError && error.code === "VALIDATION_FAILED",
  );
});
