import test from "node:test";
import assert from "node:assert/strict";
import { buildFlexibleSchemeCycleRows } from "../src/lib/calendar-cycle.js";
import {
  assessMaturityContributionEligibility,
  assessNormalMaturityTransitionEligibility,
} from "../src/lib/maturity-eligibility.js";
import { SchemeStatus } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { Message, Scheme } from "../src/models/index.js";
import { runMaturityTransitionBatch } from "../src/services/scheme-maintenance.service.js";
import { settlementPreview } from "../src/services/redemption.service.js";
import { ClosureType } from "../src/constants/enums.js";
import dayjs from "dayjs";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function paidFixedInstallments(count, amountPaise = 100_000) {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    dueDate: `2026-${String(index + 1).padStart(2, "0")}-01`,
    amountPaise,
    paidPaise: amountPaise,
    status: "PAID",
    graceEndsAt: `2026-${String(index + 1).padStart(2, "0")}-05`,
  }));
}

const flexRules6_5 = {
  flexiblePhaseCycles: 6,
  cappedPhaseCycles: 5,
  averagingDivisor: 6,
  flexiblePhase: { minimumPaymentPaise: 10_000, maximumPaymentPaise: 2_500_000, paymentIncrementPaise: 1_000 },
  capComputation: {
    formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
    roundingMode: "ROUND_UP",
    roundToNearestPaise: 10_000,
    minCycleCapPaise: 50_000,
    maxCycleCapPaise: 10_000_000,
    onZeroFlexiblePhaseTotal: "CLOSE_SCHEME",
    onBelowMinimumTotal: "USE_MINIMUM",
  },
  cappedPhase: { minimumPaymentPaise: 10_000, paymentIncrementPaise: 1_000, allowFinalRemainderBelowMinimum: true },
};

test("fully paid fixed scheme matures on calendar end", async () => {
  const { tenant, branch } = await seedTenantUser();
  await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    planId: createId("schemePlan"),
    enrollmentNumber: "MAT-FIX-OK",
    planSnapshot: { paymentPattern: "FIXED" },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: SchemeStatus.ACTIVE,
    startDate: "2026-01-01",
    maturityDate: "2026-06-30",
    installments: paidFixedInstallments(6),
  });
  const batch = await runMaturityTransitionBatch({ today: "2026-07-01" });
  assert.equal(batch.processed, 1);
  const row = await Scheme.findOne({ enrollmentNumber: "MAT-FIX-OK" }).lean();
  assert.equal(row.status, SchemeStatus.MATURED);
});

test("fixed scheme with unpaid instalment does not mature", async () => {
  const { tenant, branch } = await seedTenantUser();
  const installments = paidFixedInstallments(3);
  installments.push({
    number: 4,
    dueDate: "2026-04-01",
    amountPaise: 100_000,
    paidPaise: 0,
    status: "DUE",
    graceEndsAt: "2026-04-05",
  });
  await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    planId: createId("schemePlan"),
    enrollmentNumber: "MAT-FIX-UNPAID",
    planSnapshot: { paymentPattern: "FIXED" },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: SchemeStatus.ACTIVE,
    startDate: "2026-01-01",
    maturityDate: "2026-06-30",
    installments,
  });
  const batch = await runMaturityTransitionBatch({ today: "2026-07-01" });
  assert.equal(batch.processed, 0);
  const row = await Scheme.findOne({ enrollmentNumber: "MAT-FIX-UNPAID" }).lean();
  assert.equal(row.status, SchemeStatus.DEFAULTED);
});

test("partially paid fixed instalment blocks maturity", () => {
  const scheme = {
    paymentPattern: "FIXED",
    installments: [
      {
        number: 1,
        status: "PARTIALLY_PAID",
        amountPaise: 100_000,
        paidPaise: 50_000,
      },
    ],
  };
  assert.equal(assessMaturityContributionEligibility(scheme).paymentEligible, false);
});

test("defaulted scheme with incomplete instalments stays non-mature", async () => {
  const { tenant, branch } = await seedTenantUser();
  await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    planId: createId("schemePlan"),
    enrollmentNumber: "MAT-DEF",
    planSnapshot: { paymentPattern: "FIXED" },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: SchemeStatus.DEFAULTED,
    startDate: "2026-01-01",
    maturityDate: "2026-06-30",
    installments: [
      {
        number: 1,
        status: "OVERDUE",
        amountPaise: 100_000,
        paidPaise: 0,
        dueDate: "2026-01-01",
        graceEndsAt: "2026-01-05",
      },
    ],
  });
  const batch = await runMaturityTransitionBatch({ today: "2026-07-01" });
  assert.equal(batch.processed, 0);
  const row = await Scheme.findOne({ enrollmentNumber: "MAT-DEF" }).lean();
  assert.equal(row.status, SchemeStatus.DEFAULTED);
});

test("flexible scheme with all capped cycles complete can mature", async () => {
  const startDate = "2026-01-10";
  const cycles = buildFlexibleSchemeCycleRows({
    startDate,
    durationMonths: 12,
    firstInstallmentMode: "COLLECT_NOW",
  });
  for (let i = 6; i < 11; i += 1) {
    cycles[i].capPaise = 100_000;
    cycles[i].paidPaise = 100_000;
    cycles[i].status = "PAID";
  }
  const { tenant, branch } = await seedTenantUser();
  await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    planId: createId("schemePlan"),
    enrollmentNumber: "MAT-FLX-OK",
    planSnapshot: {
      paymentPattern: "FLEXIBLE",
      durationMonths: 12,
      installmentCount: 11,
      flexibleRules: flexRules6_5,
    },
    valueBasis: "CASH",
    paymentPattern: "FLEXIBLE",
    status: SchemeStatus.LOCKED,
    startDate,
    maturityDate: cycles[11].expiresAt,
    cycles,
  });
  const runDay = dayjs(cycles[11].expiresAt).add(1, "day").format("YYYY-MM-DD");
  const batch = await runMaturityTransitionBatch({ today: runDay });
  assert.equal(batch.processed, 1);
});

test("flexible incomplete capped cycle blocks maturity", async () => {
  const startDate = "2026-01-10";
  const cycles = buildFlexibleSchemeCycleRows({
    startDate,
    durationMonths: 12,
    firstInstallmentMode: "COLLECT_NOW",
  });
  for (let i = 6; i < 11; i += 1) {
    cycles[i].capPaise = 100_000;
    cycles[i].paidPaise = i === 10 ? 40_000 : 100_000;
    cycles[i].status = i === 10 ? "PARTIALLY_PAID" : "PAID";
  }
  const { tenant, branch } = await seedTenantUser();
  await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    planId: createId("schemePlan"),
    enrollmentNumber: "MAT-FLX-BAD",
    planSnapshot: {
      paymentPattern: "FLEXIBLE",
      durationMonths: 12,
      installmentCount: 11,
      flexibleRules: flexRules6_5,
    },
    valueBasis: "CASH",
    paymentPattern: "FLEXIBLE",
    status: SchemeStatus.LOCKED,
    startDate,
    maturityDate: cycles[11].expiresAt,
    cycles,
  });
  const runDay = dayjs(cycles[11].expiresAt).add(1, "day").format("YYYY-MM-DD");
  const batch = await runMaturityTransitionBatch({ today: runDay });
  assert.equal(batch.processed, 0);
});

test("maturity-only final cycle is not required for contributions", () => {
  const startDate = "2026-01-10";
  const cycles = buildFlexibleSchemeCycleRows({
    startDate,
    durationMonths: 12,
    firstInstallmentMode: "COLLECT_NOW",
  });
  for (let i = 6; i < 11; i += 1) {
    cycles[i].capPaise = 100_000;
    cycles[i].paidPaise = 100_000;
    cycles[i].status = "PAID";
  }
  const scheme = {
    paymentPattern: "FLEXIBLE",
    planSnapshot: {
      paymentPattern: "FLEXIBLE",
      durationMonths: 12,
      installmentCount: 11,
      flexibleRules: flexRules6_5,
    },
    cycles,
  };
  assert.equal(assessMaturityContributionEligibility(scheme).paymentEligible, true);
  assert.equal(cycles[11].capPaise ?? 0, 0);
});

test("no maturity notification when contributions incomplete", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: "MAT-NO-NOTIF",
    planSnapshot: { paymentPattern: "FIXED" },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: SchemeStatus.ACTIVE,
    startDate: "2026-01-01",
    maturityDate: "2026-06-30",
    installments: [],
  });
  await runMaturityTransitionBatch({ today: "2026-07-01" });
  const messages = await Message.countDocuments({
    tenantId: tenant._id,
    type: "SCHEME_MATURED",
  });
  assert.equal(messages, 0);
});

test("redemption preview blocks stale MATURED with incomplete contributions", async () => {
  const { tenant, branch, user } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: "MAT-STALE",
    planSnapshot: {
      paymentPattern: "FIXED",
      redemptionRules: { allowedModes: ["CASH"], prematureClosureAllowed: false },
    },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: SchemeStatus.MATURED,
    startDate: "2026-01-01",
    maturityDate: "2026-06-30",
    installments: [
      {
        number: 1,
        status: "DUE",
        amountPaise: 100_000,
        paidPaise: 0,
        dueDate: "2026-01-01",
        graceEndsAt: "2026-01-05",
      },
    ],
  });
  const preview = await settlementPreview(
    {
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
      scope: { tenantId: tenant._id, branchId: branch._id },
      params: { schemeId: scheme._id },
      body: { mode: "CASH" },
    },
    ClosureType.MATURITY_REDEMPTION,
  );
  assert.equal(preview.eligible, false);
  assert.ok(preview.blockers.some((b) => b.code === "MATURITY_CONTRIBUTIONS_INCOMPLETE"));
});

test("scheduler replay remains idempotent for eligible scheme", async () => {
  const { tenant, branch } = await seedTenantUser();
  await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    planId: createId("schemePlan"),
    enrollmentNumber: "MAT-IDEM",
    planSnapshot: { paymentPattern: "FIXED" },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: SchemeStatus.ACTIVE,
    startDate: "2026-01-01",
    maturityDate: "2026-09-18",
    installments: paidFixedInstallments(9),
  });
  const today = "2026-09-19";
  const first = await runMaturityTransitionBatch({ today });
  assert.equal(first.processed, 1);
  const second = await runMaturityTransitionBatch({ today });
  assert.equal(second.processed, 0);
});

test("assessNormalMaturityTransitionEligibility separates calendar and payment", () => {
  const scheme = {
    maturityDate: "2026-06-30",
    paymentPattern: "FIXED",
    installments: paidFixedInstallments(2),
  };
  const before = assessNormalMaturityTransitionEligibility(scheme, "2026-06-15");
  assert.equal(before.calendarEligible, false);
  assert.equal(before.paymentEligible, true);
  const after = assessNormalMaturityTransitionEligibility(scheme, "2026-07-01");
  assert.equal(after.calendarEligible, true);
  assert.equal(after.eligible, true);
});
