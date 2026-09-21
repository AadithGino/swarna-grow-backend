import test from "node:test";
import assert from "node:assert/strict";
import { createId } from "../src/lib/ids.js";
import { LedgerEntry, Scheme, SchemePlan } from "../src/models/index.js";
import {
  LedgerEntryType,
  PaymentPattern,
  SchemeStatus,
  TenantRole,
  ValueBasis,
} from "../src/constants/enums.js";
import { computePlanBenefitLiabilityPaise } from "../src/services/plan.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function seedPlan(tenant, benefit) {
  return SchemePlan.create({
    _id: createId("schemePlan"),
    tenantId: tenant._id,
    name: "Benefit plan",
    code: `BP${Date.now().toString().slice(-6)}`,
    status: "ACTIVE",
    valueBasis: ValueBasis.CASH,
    paymentPattern: PaymentPattern.FIXED,
    durationMonths: 11,
    installmentCount: 11,
    version: 1,
    amountRules: { amountMode: "JEWELLER_FIXED", fixedAmountPaise: 100_000 },
    scheduleRules: { dueDateRule: "JOIN_ANNIVERSARY", firstInstallmentModeDefault: "START_NEXT_CYCLE" },
    paymentRules: { partialPaymentAllowed: false, minPaymentPaise: 100_000 },
    redemptionRules: {
      prematureClosureAllowed: false,
      lockInMonths: 0,
      prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
      allowedModes: ["CASH"],
      redeemAtAnyBranch: false,
    },
    benefit,
    availability: { allBranches: true, visibleInCustomerApp: true, customerSelfEnrolAllowed: true },
  });
}

async function seedSchemeWithPaid({ tenant, branch, user, planId, status, paidPaise, installmentAmountPaise }) {
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    planId,
    enrollmentNumber: `ENR-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    planSnapshot: { paymentPattern: "FIXED" },
    valueBasis: ValueBasis.CASH,
    paymentPattern: PaymentPattern.FIXED,
    status,
    startDate: "2024-01-01",
    maturityDate: "2025-12-01",
    installmentAmountPaise: installmentAmountPaise ?? 100_000,
    installments: [],
    version: 1,
    createdBy: user._id,
  });
  if (paidPaise > 0) {
    await LedgerEntry.create({
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId: scheme.customerId,
      type: LedgerEntryType.INSTALLMENT_PAYMENT,
      sequence: 1,
      amountPaise: paidPaise,
      actorType: "USER",
      actorId: user._id,
    });
  }
  return scheme;
}

test("two schemes with unequal balances and per-scheme maxBonus cap", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const plan = await seedPlan(tenant, {
    type: "FIXED_BONUS_AMOUNT",
    bonusBasis: "PERCENT_OF_PAID",
    bonusValue: 10,
    maxBonusPaise: 5_000,
    eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
  });
  await seedSchemeWithPaid({ tenant, branch, user, planId: plan._id, status: SchemeStatus.ACTIVE, paidPaise: 100_000 });
  await seedSchemeWithPaid({ tenant, branch, user, planId: plan._id, status: SchemeStatus.ACTIVE, paidPaise: 200_000 });

  const liability = await computePlanBenefitLiabilityPaise(tenant._id, plan.toObject());
  assert.equal(liability, 10_000);
});

test("ONE_FREE_INSTALLMENT uses each scheme installmentAmountPaise", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const plan = await seedPlan(tenant, {
    type: "ONE_FREE_INSTALLMENT",
    eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
  });
  await seedSchemeWithPaid({
    tenant,
    branch,
    user,
    planId: plan._id,
    status: SchemeStatus.ACTIVE,
    paidPaise: 300_000,
    installmentAmountPaise: 80_000,
  });
  await seedSchemeWithPaid({
    tenant,
    branch,
    user,
    planId: plan._id,
    status: SchemeStatus.ACTIVE,
    paidPaise: 500_000,
    installmentAmountPaise: 120_000,
  });

  const liability = await computePlanBenefitLiabilityPaise(tenant._id, plan.toObject());
  assert.equal(liability, 200_000);
});

test("reversal reduces liability via lower net paid on scheme totals", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const plan = await seedPlan(tenant, {
    type: "FIXED_BONUS_AMOUNT",
    bonusBasis: "PERCENT_OF_PAID",
    bonusValue: 10,
    eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
  });
  const high = await seedSchemeWithPaid({ tenant, branch, user, planId: plan._id, status: SchemeStatus.ACTIVE, paidPaise: 500_000 });
  await seedSchemeWithPaid({ tenant, branch, user, planId: plan._id, status: SchemeStatus.ACTIVE, paidPaise: 200_000 });
  await LedgerEntry.create({
    _id: createId("ledger"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: high._id,
    customerId: high.customerId,
    type: LedgerEntryType.REVERSAL,
    sequence: 2,
    amountPaise: 300_000,
    actorType: "USER",
    actorId: user._id,
  });

  const liability = await computePlanBenefitLiabilityPaise(tenant._id, plan.toObject());
  assert.equal(liability, 20_000 + 20_000);
});

test("matured unredeemed counts; redeemed does not", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const plan = await seedPlan(tenant, {
    type: "FIXED_BONUS_AMOUNT",
    bonusBasis: "FLAT",
    bonusValue: 15_000,
    eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
  });
  await seedSchemeWithPaid({ tenant, branch, user, planId: plan._id, status: SchemeStatus.MATURED, paidPaise: 100_000 });
  await seedSchemeWithPaid({ tenant, branch, user, planId: plan._id, status: SchemeStatus.REDEEMED, paidPaise: 100_000 });
  await seedSchemeWithPaid({ tenant, branch, user, planId: plan._id, status: SchemeStatus.CLOSED_PREMATURE, paidPaise: 50_000 });

  const liability = await computePlanBenefitLiabilityPaise(tenant._id, plan.toObject());
  assert.equal(liability, 15_000);
});

test("flat and percentage configurations", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const flatPlan = await seedPlan(tenant, {
    type: "FIXED_BONUS_AMOUNT",
    bonusBasis: "FLAT",
    bonusValue: 25_000,
    eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
  });
  await seedSchemeWithPaid({ tenant, branch, user, planId: flatPlan._id, status: SchemeStatus.ACTIVE, paidPaise: 1_000_000 });
  assert.equal(await computePlanBenefitLiabilityPaise(tenant._id, flatPlan.toObject()), 25_000);

  const pctPlan = await seedPlan(tenant, {
    type: "FIXED_BONUS_AMOUNT",
    bonusBasis: "PERCENT_OF_PAID",
    bonusValue: 5,
    eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
  });
  await seedSchemeWithPaid({ tenant, branch, user, planId: pctPlan._id, status: SchemeStatus.ACTIVE, paidPaise: 400_000 });
  assert.equal(await computePlanBenefitLiabilityPaise(tenant._id, pctPlan.toObject()), 20_000);
});
