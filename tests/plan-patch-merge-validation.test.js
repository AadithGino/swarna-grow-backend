import test from "node:test";
import assert from "node:assert/strict";
import { PlanTier, RedemptionMode, TenantRole } from "../src/constants/enums.js";
import { SchemePlan, Tenant } from "../src/models/index.js";
import { AppError } from "../src/lib/app-error.js";
import { createPlan, updatePlan } from "../src/services/plan.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function planReq(tenant, user, planId, body) {
  return {
    params: { planId },
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    tenant,
    headers: { "user-agent": "test" },
    ip: "127.0.0.1",
    body,
  };
}

const fixedPlanBase = {
  name: "Fixed saver",
  code: "FIXSAVE12",
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

function flexibleRules(flexiblePhaseCycles, cappedPhaseCycles) {
  return {
    phaseMode: "FLEXIBLE_THEN_CAPPED",
    capMode: "FLEXIBLE_PHASE_AVERAGE",
    carryForwardMode: "NONE",
    flexiblePhaseCycles,
    cappedPhaseCycles,
    averagingDivisor: flexiblePhaseCycles,
    frequencyMode: "MULTIPLE",
    flexiblePhase: {
      minimumPaymentPaise: 10_000,
      maximumPaymentPaise: 2_500_000,
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
  };
}

function flexiblePlanBody(flexiblePhaseCycles, cappedPhaseCycles) {
  return {
    name: "Flex plan",
    code: "FLEXSAVE12",
    valueBasis: "CASH",
    paymentPattern: "FLEXIBLE",
    durationMonths: flexiblePhaseCycles + cappedPhaseCycles,
    installmentCount: flexiblePhaseCycles + cappedPhaseCycles,
    amountRules: {
      amountMode: "CUSTOMER_CHOSEN",
      minInstallmentPaise: 10_000,
      maxInstallmentPaise: 2_500_000,
      multipleOfPaise: 1_000,
    },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      firstInstallmentModeDefault: "COLLECT_NOW",
    },
    paymentRules: { partialPaymentAllowed: true, minPaymentPaise: 10_000 },
    flexibleRules: flexibleRules(flexiblePhaseCycles, cappedPhaseCycles),
    redemptionRules: fixedPlanBase.redemptionRules,
    availability: fixedPlanBase.availability,
    benefit: {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "FLAT",
      bonusValue: 50_000,
      displayLabel: "Flat bonus",
      eligibility: fixedPlanBase.benefit.eligibility,
    },
  };
}

async function seedGrowthTenantUser() {
  const seeded = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await Tenant.updateOne(
    { _id: seeded.tenant._id },
    { $set: { "subscription.tier": PlanTier.GROWTH } },
  );
  const tenant = await Tenant.findById(seeded.tenant._id).lean();
  return { ...seeded, tenant };
}

async function assertPlanUnchanged(planId, snapshot) {
  const after = await SchemePlan.findById(planId).lean();
  assert.deepEqual(
    {
      version: after.version,
      durationMonths: after.durationMonths,
      paymentPattern: after.paymentPattern,
      valueBasis: after.valueBasis,
      flexibleRules: after.flexibleRules,
      goldRules: after.goldRules,
      displayName: after.displayName,
    },
    snapshot,
  );
}

test("PATCH durationMonths alone rejects when merged phase sum no longer matches", async () => {
  const { tenant, user } = await seedGrowthTenantUser();
  const created = await createPlan({
    ...planReq(tenant, user, undefined, flexiblePlanBody(6, 6)),
    body: flexiblePlanBody(6, 6),
  });
  const snapshot = {
    version: created.version,
    durationMonths: 12,
    paymentPattern: "FLEXIBLE",
    valueBasis: "CASH",
    flexibleRules: created.flexibleRules,
    goldRules: created.goldRules ?? null,
    displayName: created.displayName,
  };
  await assert.rejects(
    () => updatePlan(planReq(tenant, user, created._id, {
      expectedVersion: created.version,
      durationMonths: 11,
    })),
    (error) => error instanceof AppError && error.code === "VALIDATION_FAILED",
  );
  await assertPlanUnchanged(created._id, snapshot);
});

test("PATCH flexibleRules alone rejects when phase sum does not match persisted duration", async () => {
  const { tenant, user } = await seedGrowthTenantUser();
  const created = await createPlan({
    ...planReq(tenant, user, undefined, flexiblePlanBody(6, 6)),
    body: flexiblePlanBody(6, 6),
  });
  const snapshot = {
    version: created.version,
    durationMonths: 12,
    paymentPattern: "FLEXIBLE",
    valueBasis: "CASH",
    flexibleRules: created.flexibleRules,
    goldRules: created.goldRules ?? null,
    displayName: created.displayName,
  };
  await assert.rejects(
    () => updatePlan(planReq(tenant, user, created._id, {
      expectedVersion: created.version,
      flexibleRules: flexibleRules(6, 5),
    })),
    (error) => error instanceof AppError && error.code === "VALIDATION_FAILED",
  );
  await assertPlanUnchanged(created._id, snapshot);
});

test("PATCH paymentPattern to FIXED rejects while persisted flexibleRules remain", async () => {
  const { tenant, user } = await seedGrowthTenantUser();
  const created = await createPlan({
    ...planReq(tenant, user, undefined, flexiblePlanBody(6, 6)),
    body: flexiblePlanBody(6, 6),
  });
  const snapshot = {
    version: created.version,
    durationMonths: 12,
    paymentPattern: "FLEXIBLE",
    valueBasis: "CASH",
    flexibleRules: created.flexibleRules,
    goldRules: created.goldRules ?? null,
    displayName: created.displayName,
  };
  await assert.rejects(
    () => updatePlan(planReq(tenant, user, created._id, {
      expectedVersion: created.version,
      paymentPattern: "FIXED",
      amountRules: fixedPlanBase.amountRules,
    })),
    (error) => error instanceof AppError && error.code === "VALIDATION_FAILED",
  );
  await assertPlanUnchanged(created._id, snapshot);
});

test("PATCH paymentPattern to FLEXIBLE without flexibleRules rejects", async () => {
  const { tenant, user } = await seedGrowthTenantUser();
  const created = await createPlan({
    ...planReq(tenant, user, undefined, fixedPlanBase),
    body: fixedPlanBase,
  });
  const snapshot = {
    version: created.version,
    durationMonths: 12,
    paymentPattern: "FIXED",
    valueBasis: "CASH",
    flexibleRules: created.flexibleRules ?? null,
    goldRules: created.goldRules ?? null,
    displayName: created.displayName,
  };
  await assert.rejects(
    () => updatePlan(planReq(tenant, user, created._id, {
      expectedVersion: created.version,
      paymentPattern: "FLEXIBLE",
      amountRules: flexiblePlanBody(6, 6).amountRules,
      paymentRules: flexiblePlanBody(6, 6).paymentRules,
    })),
    (error) => error instanceof AppError && error.code === "VALIDATION_FAILED",
  );
  await assertPlanUnchanged(created._id, snapshot);
});

test("PATCH valueBasis to GOLD_WEIGHT without goldRules rejects", async () => {
  const { tenant, user } = await seedGrowthTenantUser();
  const created = await createPlan({
    ...planReq(tenant, user, undefined, fixedPlanBase),
    body: fixedPlanBase,
  });
  const snapshot = {
    version: created.version,
    durationMonths: 12,
    paymentPattern: "FIXED",
    valueBasis: "CASH",
    flexibleRules: created.flexibleRules ?? null,
    goldRules: created.goldRules ?? null,
    displayName: created.displayName,
  };
  await assert.rejects(
    () => updatePlan(planReq(tenant, user, created._id, {
      expectedVersion: created.version,
      valueBasis: "GOLD_WEIGHT",
    })),
    (error) => error instanceof AppError && error.code === "VALIDATION_FAILED",
  );
  await assertPlanUnchanged(created._id, snapshot);
});

test("PATCH duration and flexibleRules together accepts valid combination", async () => {
  const { tenant, user } = await seedGrowthTenantUser();
  const created = await createPlan({
    ...planReq(tenant, user, undefined, flexiblePlanBody(6, 6)),
    body: flexiblePlanBody(6, 6),
  });
  const updated = await updatePlan(planReq(tenant, user, created._id, {
    expectedVersion: created.version,
    durationMonths: 10,
    installmentCount: 10,
    flexibleRules: flexibleRules(5, 5),
  }));
  assert.equal(updated.durationMonths, 10);
  assert.equal(updated.flexibleRules.flexiblePhaseCycles, 5);
  assert.equal(updated.flexibleRules.cappedPhaseCycles, 5);
  assert.equal(updated.version, created.version + 1);
});

test("PATCH only flexibleRules accepts when phase sum still equals duration", async () => {
  const { tenant, user } = await seedGrowthTenantUser();
  const created = await createPlan({
    ...planReq(tenant, user, undefined, flexiblePlanBody(6, 6)),
    body: flexiblePlanBody(6, 6),
  });
  const updated = await updatePlan(planReq(tenant, user, created._id, {
    expectedVersion: created.version,
    flexibleRules: flexibleRules(4, 8),
  }));
  assert.equal(updated.durationMonths, 12);
  assert.equal(updated.flexibleRules.flexiblePhaseCycles, 4);
  assert.equal(updated.flexibleRules.cappedPhaseCycles, 8);
});

test("PATCH unrelated displayName accepts when plan stays valid", async () => {
  const { tenant, user } = await seedGrowthTenantUser();
  const created = await createPlan({
    ...planReq(tenant, user, undefined, fixedPlanBase),
    body: fixedPlanBase,
  });
  const updated = await updatePlan(planReq(tenant, user, created._id, {
    expectedVersion: created.version,
    displayName: "Renamed fixed plan",
  }));
  assert.equal(updated.displayName, "Renamed fixed plan");
  assert.equal(updated.durationMonths, 12);
});

test("PATCH to GOLD_WEIGHT with goldRules accepts", async () => {
  const { tenant, user } = await seedGrowthTenantUser();
  const created = await createPlan({
    ...planReq(tenant, user, undefined, fixedPlanBase),
    body: fixedPlanBase,
  });
  const updated = await updatePlan(planReq(tenant, user, created._id, {
    expectedVersion: created.version,
    valueBasis: "GOLD_WEIGHT",
    goldRules: {
      rateSource: "TENANT_DAILY_RATE",
      weightRoundingMode: "HALF_UP",
      weightPrecisionMg: 1,
      blockPaymentIfRateNotSet: true,
    },
    benefit: {
      type: "ONE_FREE_INSTALLMENT",
      displayLabel: "Bonus instalment",
      eligibility: fixedPlanBase.benefit.eligibility,
    },
  }));
  assert.equal(updated.valueBasis, "GOLD_WEIGHT");
  assert.equal(updated.goldRules.rateSource, "TENANT_DAILY_RATE");
});

test("PATCH FIXED to FLEXIBLE with complete flexibleRules accepts", async () => {
  const { tenant, user } = await seedGrowthTenantUser();
  const body = { ...fixedPlanBase, code: "FIX2FLEX" };
  const created = await createPlan({
    ...planReq(tenant, user, undefined, body),
    body,
  });
  const flexBody = flexiblePlanBody(3, 9);
  const updated = await updatePlan(planReq(tenant, user, created._id, {
    expectedVersion: created.version,
    paymentPattern: "FLEXIBLE",
    amountRules: flexBody.amountRules,
    scheduleRules: flexBody.scheduleRules,
    paymentRules: flexBody.paymentRules,
    flexibleRules: flexBody.flexibleRules,
    benefit: flexBody.benefit,
  }));
  assert.equal(updated.paymentPattern, "FLEXIBLE");
  assert.equal(updated.flexibleRules.flexiblePhaseCycles, 3);
  assert.equal(updated.flexibleRules.cappedPhaseCycles, 9);
});
