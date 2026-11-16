import { mapCustomerPlanListItem } from "../src/lib/customer-app-dto.js";
import { mapCustomerSchemeDetail } from "../src/lib/customer-scheme-detail-dto.js";
import { collectionBonusWeight } from "../src/lib/maturity-gold-benefit.js";
import { collectionListFilters } from "../src/lib/query-filters.js";
import { buildSchemeMaturityProjection } from "../src/lib/maturity-projection.js";
import test from "node:test";
import assert from "node:assert/strict";
import { GoldRate, LedgerEntry, Payment, Scheme } from "../src/models/index.js";
import { recordPayment, reversePayment } from "../src/services/payment.service.js";
import { assertCollectionAmountsAtRate, buildCollectionSchedule } from "../src/lib/collection-schedule.js";
import { resetCalendarDateOverrideForTests, setCalendarDateOverrideForTests } from "../src/lib/date.js";
import { computePlanBenefitLiabilityPaise, createPlan, previewSchedule } from "../src/services/plan.service.js";
import { enrol, getPassbook, getScheme, validateEnrolmentResponse } from "../src/services/scheme.service.js";
import { reserveFixedPaymentIntentInSession } from "../src/lib/fixed-payment-reservation.js";
import { withTransaction } from "../src/lib/transaction.js";
import { runMaturityTransitionBatch } from "../src/services/scheme-maintenance.service.js";
import { releaseHandoverOtp, requestCustomerRedemption, revealCustomerHandoverOtp, settlementPreview, transitionRedemption } from "../src/services/redemption.service.js";
import { seedCustomer, seedTenantUser, startTestDb, stopTestDb, resetTestDb } from "./helpers/db.js";

const frequencies = ["DAILY", "WEEKLY", "MONTHLY"];
const rules = {
  frequencies,
  amountBasis: "PER_COLLECTION",
  maturityRule: "ENROLMENT_ANNIVERSARY",
  bonusBasis: "NET_GOLD_WEIGHT",
  bonusPercent: 7,
  requireAllCollections: true,
};
const scheduleRules = { dueDateRule: "JOIN_ANNIVERSARY", firstInstallmentModeDefault: "COLLECT_NOW", graceDays: 2 };
const goldRules = {
  rateSource: "TENANT_DAILY_RATE",
  weightRoundingMode: "HALF_UP",
  weightPrecisionMg: 1,
  blockPaymentIfRateNotSet: true,
};

test("all nine Aira schedules end at the full-month anniversary and split whole paise", () => {
  for (const [durationMonths, bonusPercent] of [[3, 3], [6, 7], [12, 15]]) {
    for (const collectionFrequency of frequencies) {
      const schedule = buildCollectionSchedule({
        plan: { durationMonths, collectionRules: { ...rules, bonusPercent, amountBasis: "TOTAL_TARGET" }, scheduleRules },
        startDate: "2024-01-31", collectionFrequency, collectionAmountPaise: 6_000_001,
        firstInstallmentMode: "COLLECT_NOW",
      });
      assert.equal(schedule.maturityDate, { 3: "2024-04-30", 6: "2024-07-31", 12: "2025-01-31" }[durationMonths]);
      assert.equal(schedule.installments.reduce((sum, row) => sum + row.amountPaise, 0), 6_000_001);
      assert.ok(schedule.installments.every((row) => row.dueDate < schedule.maturityDate && row.graceEndsAt > row.dueDate));
      assert.equal(schedule.installments[1].dueDate, { DAILY: "2024-02-01", WEEKLY: "2024-02-07", MONTHLY: "2024-02-29" }[collectionFrequency]);
      if (collectionFrequency === "MONTHLY") assert.equal(schedule.installments[2].dueDate, "2024-03-31");
    }
  }
});

test("scheme builder previews collection schedules, flexible timing, and fixed monetary benefits", async () => {
  const startDate = "2028-01-31";
  const shared = { startDate, durationMonths: 3, installmentCount: 3, installmentAmountPaise: 100_000 };
  for (const collectionFrequency of frequencies) {
    const preview = await previewSchedule({
      ...shared, valueBasis: "GOLD_WEIGHT", paymentPattern: "FIXED", firstInstallmentMode: "COLLECT_NOW",
      collectionRules: { ...rules, amountBasis: "TOTAL_TARGET" }, collectionFrequency,
    });
    assert.equal(preview.summary.maturityDate, "2028-04-30");
    assert.equal(preview.summary.totalPayable.amountPaise, 100_000);
    assert.equal(preview.schedule.reduce((sum, row) => sum + row.amount.amountPaise, 0), 100_000);
    assert.equal(preview.summary.estimatedMaturityValue, null);
  }
  for (const [firstInstallmentMode, end] of [["COLLECT_NOW", "2028-03-31"], ["START_NEXT_CYCLE", "2028-04-30"]]) {
    const preview = await previewSchedule({
      ...shared, paymentPattern: "FLEXIBLE", firstInstallmentMode,
      flexibleRules: { flexiblePhaseCycles: 1, cappedPhaseCycles: 2 },
    });
    assert.equal(preview.summary.maturityDate, end);
    assert.equal(preview.summary.cappedPhase.to, end);
  }
  const preview = await previewSchedule({
    ...shared, valueBasis: "CASH", paymentPattern: "FIXED",
    benefit: { type: "FIXED_BONUS_AMOUNT", bonusBasis: "PERCENT_OF_PAID", bonusValue: 10, maxBonusPaise: 12_000 },
  });
  assert.equal(preview.summary.estimatedMaturityValue.amountPaise, 312_000);
});

test("small daily slabs cannot produce zero-weight payments", () => {
  const plan = { durationMonths: 12, collectionRules: { ...rules, amountBasis: "TOTAL_TARGET" } };
  const collection = buildCollectionSchedule({ plan, startDate: "2026-11-16", collectionFrequency: "DAILY",
    collectionAmountPaise: 100_000, firstInstallmentMode: "COLLECT_NOW" });
  assert.equal(collection.installments[0].amountPaise, 273);
  assert.throws(() => assertCollectionAmountsAtRate(collection.installments, { ratePerGramPaise: 700_000 }, goldRules),
    { code: "GOLD_WEIGHT_ROUNDS_TO_ZERO" });
});

test("a gateway success across midnight keeps the accepted rows, cap and booked rate", async () => {
  await startTestDb();
  await resetTestDb();
  try {
    setCalendarDateOverrideForTests("2026-01-30");
    const { tenant, branch, user } = await seedTenantUser();
    const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
    const scope = { tenantId: tenant._id, branchId: branch._id };
    const plan = {
      durationMonths: 3, goldRules,
      collectionRules: { ...rules, amountBasis: "TOTAL_TARGET", maturityRule: "FIRST_PAYMENT_ANNIVERSARY" },
      paymentRules: { partialPaymentAllowed: false, maxPaymentPerTransactionPaise: 50_000 },
    };
    const schedule = buildCollectionSchedule({ plan, startDate: "2026-01-30", collectionFrequency: "DAILY",
      collectionAmountPaise: 4_500_000, firstInstallmentMode: "COLLECT_NOW" });
    const scheme = await Scheme.create({
      ...scope, customerId: customer._id, planId: "plan_rollover", enrollmentNumber: "ENR-ROLLOVER",
      planSnapshot: plan, collectionFrequency: "DAILY", collectionAmountPaise: 4_500_000,
      paymentPattern: "FIXED", valueBasis: "GOLD_WEIGHT", status: "PENDING_PAYMENT",
      startDate: "2026-01-30", maturityDate: "2026-04-30", installments: schedule.installments,
      installmentAmountPaise: 50_000,
    });
    await GoldRate.create({ ...scope, effectiveDate: "2026-01-30", ratePerGramPaise: 600_000 });
    const { intent } = await withTransaction((session) => reserveFixedPaymentIntentInSession(session, {
      tenantId: tenant._id, scheme, amountPaise: 50_000, expiresAt: new Date(Date.now() + 30 * 60_000),
    }));
    assert.equal(intent.collectionRatePerGramPaise, 600_000);
    setCalendarDateOverrideForTests("2026-01-31");
    await GoldRate.create({ ...scope, effectiveDate: "2026-01-31", ratePerGramPaise: 700_000 });
    const payment = await recordPayment({
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER", role: user.role }, scope,
      body: { schemeId: scheme._id, amountPaise: 50_000 },
      baseUrl: "/api/v1/admin", headers: {}, query: {}, ip: "127.0.0.1",
    }, { gateway: true, fixedReservationIntent: intent.toObject(), paidAt: new Date("2026-01-31T00:30:00+05:30") });
    assert.equal(payment.status, "SUCCESS");
    const recorded = await Payment.findOne({ schemeId: scheme._id }).lean();
    assert.equal(recorded.ratePerGramPaise, 600_000);
    assert.equal(recorded.weightMg, 83);
    const activated = await Scheme.findById(scheme._id);
    assert.equal(activated.status, "ACTIVE");
    assert.equal(activated.startDate, "2026-01-31");
    assert.equal(activated.maturityDate, "2026-04-30");
    assert.equal(activated.installments.length, 90);
    assert.equal(activated.installments[0].status, "PAID");
    assert.ok(activated.installments.every((row, index) =>
      row.amountPaise === 50_000 && row.dueDate === schedule.installments[index].dueDate));
  } finally {
    resetCalendarDateOverrideForTests();
    await stopTestDb();
  }
});

test("maturity waits until open grace ends for both contribution policies", async () => {
  await startTestDb();
  await resetTestDb();
  try {
    const { tenant, branch } = await seedTenantUser();
    const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
    const ids = [];
    for (const requireAllCollections of [true, false]) {
      const scheme = await Scheme.create({
        tenantId: tenant._id, branchId: branch._id, customerId: customer._id,
        planId: "plan-grace", enrollmentNumber: `ENR-GRACE-${requireAllCollections}`,
        planSnapshot: { collectionRules: { ...rules, requireAllCollections }, goldRules },
        collectionFrequency: "DAILY", valueBasis: "GOLD_WEIGHT", paymentPattern: "FIXED",
        startDate: "2026-06-01", maturityDate: "2026-12-01", status: "ACTIVE",
        installments: [
          { number: 1, dueDate: "2026-11-29", graceEndsAt: "2026-12-01", amountPaise: 100_000, paidPaise: 100_000, status: "PAID" },
          { number: 2, dueDate: "2026-11-30", graceEndsAt: "2026-12-02", amountPaise: 100_000, paidPaise: 0, status: "DUE" },
        ],
      });
      ids.push(scheme._id);
      await LedgerEntry.create({
        tenantId: tenant._id, branchId: branch._id, customerId: customer._id, schemeId: scheme._id,
        type: "INSTALLMENT_PAYMENT", sequence: 1, amountPaise: 100_000, weightMg: 100,
      });
    }
    for (const today of ["2026-12-01", "2026-12-02"]) {
      assert.equal((await runMaturityTransitionBatch({ today })).processed, 0);
      assert.equal(await Scheme.countDocuments({ _id: { $in: ids }, status: "ACTIVE" }), 2);
    }
    assert.equal((await runMaturityTransitionBatch({ today: "2026-12-03" })).processed, 1);
    assert.equal((await Scheme.findById(ids[0])).status, "DEFAULTED");
    assert.equal((await Scheme.findById(ids[1])).collectionBonus.weightMg, 7);
  } finally {
    await stopTestDb();
  }
});

for (const [schedule, mode] of [
  ["legacy selectable frequency", "CASH"],
  ["new selectable frequency", "CASH"],
  ["standard monthly", "CASH"],
  ["standard monthly", "GOLD_HANDOVER"],
  ["standard monthly", "PURCHASE_ADJUSTMENT"],
]) {
  test(`${schedule}: maturity credits 0.700 g once and ${mode} settlement consumes it`, async () => {
    const hasFrequency = schedule !== "standard monthly";
    const legacy = schedule === "legacy selectable frequency";
    await startTestDb();
    await resetTestDb();
    try {
      setCalendarDateOverrideForTests("2026-06-01");
      const { tenant, branch, user } = await seedTenantUser();
      const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
      const auth = { id: user._id, tenantId: tenant._id, type: "TENANT_USER", role: user.role };
      const scope = { tenantId: tenant._id, branchId: branch._id };
      const req = { auth, scope, tenant: tenant.toObject(), baseUrl: "/api/v1/admin", headers: {}, ip: "127.0.0.1", query: {} };
      const plan = await createPlan({ ...req, body: {
        name: "Akshaya", code: "AKS", paymentPattern: "FIXED", valueBasis: "GOLD_WEIGHT",
        durationMonths: 6, installmentCount: hasFrequency ? 1 : 6, status: "ACTIVE",
        ...(hasFrequency ? { collectionRules: legacy ? rules : {
          frequencies, amountBasis: rules.amountBasis, maturityRule: rules.maturityRule,
        } } : {}),
        ...(!legacy ? { benefit: {
          type: "MATURITY_GOLD_CREDIT",
          goldBonus: { bonusPercent: 7, bonusBasis: "NET_GOLD_WEIGHT", requireAllCollections: true },
          displayLabel: "7% additional gold at maturity",
          eligibility: { requireAllInstallmentsPaid: false, maxAllowedDefaults: 0, minMonthsCompleted: 0 },
        } } : {}),
        amountRules: { amountMode: "JEWELLER_FIXED", fixedAmountPaise: 1_000_000 },
        scheduleRules: { ...scheduleRules, firstInstallmentModeEditable: false },
        paymentRules: { partialPaymentAllowed: false, advancePaymentAllowed: true, maxAdvanceInstallments: 5, maxPaymentPerTransactionPaise: 6_000_000 },
        goldRules,
        redemptionRules: { allowedModes: [mode], prematureClosureAllowed: false, lockInMonths: 6,
          prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" }, redeemAtAnyBranch: false },
        availability: { allBranches: true, branchIds: [], visibleInCustomerApp: true, customerSelfEnrolAllowed: true },
      } });
      const enrolRequest = { ...req, body: {
        customerId: customer._id, planId: plan._id, ...(hasFrequency ? { collectionFrequency: "MONTHLY" } : {}), firstInstallmentMode: "COLLECT_NOW",
      } };
      await GoldRate.create({ tenantId: tenant._id, branchId: branch._id, effectiveDate: "2026-06-01", ratePerGramPaise: 600_000 });
      const preview = await validateEnrolmentResponse(enrolRequest);
      assert.equal(preview.valid, true, JSON.stringify(preview));
      assert.equal(preview.preview.installmentCount, 6);
      const catalog = mapCustomerPlanListItem(plan);
      assert.equal(catalog.maturityGoldBonus.bonusPercent, 7);
      assert.equal(catalog.benefitType, "GOLD_BENEFIT");
      if (hasFrequency) {
        assert.equal((await previewSchedule({ planId: plan._id, startDate: "2026-06-01", collectionFrequency: "DAILY" }, tenant._id)).summary.installmentCount, 183);
      }
      const enrolled = await enrol({ ...enrolRequest, body: {
        ...enrolRequest.body, firstInstallmentAction: "RECORD_MANUAL_PAYMENT", payment: { amountPaise: 6_000_000, mode: "UPI" },
      } });
      assert.equal(enrolled.collectionFrequency, hasFrequency ? "MONTHLY" : undefined);
      assert.equal(enrolled.status, "ACTIVE");
      assert.equal(enrolled.installments.length, 6);
      const adminRequest = { ...req, params: { schemeId: enrolled._id } };
      const pending = await getScheme(adminRequest);
      assert.equal(pending.collectionBonus.estimatedWeightMg, 700);
      assert.equal(mapCustomerSchemeDetail(pending).maturityBenefit.type, "GOLD_BENEFIT");
      assert.equal((await runMaturityTransitionBatch({ today: "2026-11-30" })).processed, 0);
      const batches = await Promise.all([
        runMaturityTransitionBatch({ today: "2026-12-01" }),
        runMaturityTransitionBatch({ today: "2026-12-01" }),
      ]);
      assert.equal(batches.reduce((total, batch) => total + batch.processed, 0), 1);
      const matured = await Scheme.findById(enrolled._id);
      assert.equal(matured.collectionBonus.weightMg, 700);
      assert.equal(matured.status, "MATURED");
      const adminDetail = await getScheme(adminRequest);
      assert.equal(buildSchemeMaturityProjection(adminDetail).collectionBonus.weightMg, 700);
      assert.equal(mapCustomerSchemeDetail(adminDetail).collectionBonus.weightMg, 700);
      assert.equal(await LedgerEntry.countDocuments({ schemeId: enrolled._id, type: "MATURITY_GOLD_CREDIT" }), 1);
      assert.equal(await computePlanBenefitLiabilityPaise(tenant._id, plan), 420_000);
      setCalendarDateOverrideForTests("2026-12-01");
      await GoldRate.create({ tenantId: tenant._id, branchId: branch._id, effectiveDate: "2026-12-01", ratePerGramPaise: 700_000 });
      const request = await requestCustomerRedemption({
        ...req, auth: { id: customer._id, tenantId: tenant._id, type: "CUSTOMER" },
        scope: { tenantId: tenant._id }, params: { schemeId: enrolled._id },
        body: {
          preferredMode: mode, expectedVersion: matured.version,
          ...(mode === "PURCHASE_ADJUSTMENT" ? { modeDetails: { billNumber: "BILL-123" } } : {}),
        },
      });
      const redemption = { ...req, params: { redemptionId: request.id }, body: {} };
      await transitionRedemption(redemption, "approve");
      await releaseHandoverOtp(redemption);
      const { handoverOtp } = await revealCustomerHandoverOtp({ ...redemption, auth: { id: customer._id, tenantId: tenant._id } });
      const complete = await transitionRedemption({ ...redemption, body: { handoverOtp } }, "complete");
      assert.equal(complete.benefitWeightMg, 700);
      assert.equal(complete.settlementPaise, 7_490_000);
      assert.equal(complete.cashOutPaise, mode === "CASH" ? 7_490_000 : 0);
      const entries = await LedgerEntry.find({ schemeId: enrolled._id }).lean();
      assert.equal(entries.filter((entry) => entry.type === "MATURITY_GOLD_CREDIT").length, 1);
      assert.ok(!entries.some((entry) => entry.type === "BENEFIT_CREDIT"));
      assert.equal(entries.find((entry) => entry.type === "REDEMPTION_DEBIT").weightMg, 10_700);
    } finally {
      resetCalendarDateOverrideForTests();
      await stopTestDb();
    }
  });
}

for (const legacy of [true, false]) {
  test(`${legacy ? "legacy" : "standard monthly"} rupee-based maturity waits for a rate and adjusts gold after reversal`, async () => {
    await startTestDb();
    await resetTestDb();
    try {
      setCalendarDateOverrideForTests("2026-12-01");
      const { tenant, branch, user } = await seedTenantUser();
      const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
      const scope = { tenantId: tenant._id, branchId: branch._id };
      const req = { auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER", role: user.role }, scope, headers: {}, ip: "127.0.0.1" };
      const goldBonus = { bonusBasis: "NET_PAID_AT_MATURITY_RATE", bonusPercent: 7, requireAllCollections: false };
      const scheme = await Scheme.create({
        ...scope, customerId: customer._id, planId: "plan_collection_fixture", enrollmentNumber: "ENR-REFUND",
        planSnapshot: {
          goldRules,
          redemptionRules: { allowedModes: ["CASH"], prematureClosureAllowed: true, lockInMonths: 0 },
          ...(legacy ? { collectionRules: { ...rules, ...goldBonus } } : { benefit: { type: "MATURITY_GOLD_CREDIT", goldBonus } }),
        },
        ...(legacy ? { collectionFrequency: "MONTHLY" } : {}), valueBasis: "GOLD_WEIGHT", paymentPattern: "FIXED",
        startDate: "2026-06-01", maturityDate: legacy ? "2026-12-01" : "2026-11-30", status: "ACTIVE",
        installments: [1, 2].map((number) => ({
          number, dueDate: `2026-0${5 + number}-01`, graceEndsAt: `2026-0${5 + number}-03`,
          amountPaise: 3_000_000, paidPaise: 3_000_000, status: "PAID",
        })),
      });
      const payments = [];
      for (const sequence of [1, 2]) {
        const payment = await Payment.create({
          ...scope, customerId: customer._id, schemeId: scheme._id, receiptNumber: `R-${sequence}`,
          mode: "UPI", source: "PORTAL", amountPaise: 3_000_000, allocatedAmountPaise: 3_000_000,
          weightMg: 5000, ratePerGramPaise: 600_000,
        });
        payments.push(payment);
        await LedgerEntry.create({
          ...scope, customerId: customer._id, schemeId: scheme._id, paymentId: payment._id,
          type: "INSTALLMENT_PAYMENT", sequence, amountPaise: payment.amountPaise, weightMg: payment.weightMg,
        });
      }
      const beforeRun = await settlementPreview({ ...req, params: { schemeId: scheme._id }, body: { mode: "CASH" } }, "PREMATURE_CLOSURE");
      assert.ok(beforeRun.blockers.some(({ code }) => code === "MATURITY_GOLD_AWAITING_POST"));
      assert.equal((await runMaturityTransitionBatch({ today: "2026-12-01" })).processed, 0);
      const afterRun = await Scheme.findById(scheme._id).lean();
      assert.equal(afterRun.collectionBonus.status, "PENDING_RATE");
      assert.equal(afterRun.positionVersion, scheme.positionVersion);
      assert.equal(await Scheme.countDocuments({ _id: scheme._id, ...collectionListFilters({ bonusStatus: "PENDING_RATE" }) }), 1);
      assert.match(mapCustomerSchemeDetail(afterRun).redemption.blocker, /bonus is resolved/);
      assert.equal((await runMaturityTransitionBatch({ today: "2026-12-02" })).processed, 0);
      assert.equal((await Scheme.findById(scheme._id)).version, afterRun.version);
      assert.equal(await LedgerEntry.countDocuments({ schemeId: scheme._id, type: "MATURITY_GOLD_CREDIT" }), 0);
      await GoldRate.create({ ...scope, effectiveDate: "2026-12-02", ratePerGramPaise: 100_000 });
      assert.equal((await runMaturityTransitionBatch({ today: "2026-12-02" })).processed, 0);
      await GoldRate.create({ ...scope, effectiveDate: scheme.maturityDate, ratePerGramPaise: 600_000 });
      assert.equal((await runMaturityTransitionBatch({ today: "2026-12-02" })).processed, 1);
      assert.equal((await Scheme.findById(scheme._id)).collectionBonus.weightMg, 700);
      await reversePayment({
        auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER", role: user.role }, scope,
        params: { paymentId: payments[0]._id }, body: { reason: "Duplicate contribution" }, headers: {}, ip: "127.0.0.1",
      });
      const adjusted = await Scheme.findById(scheme._id);
      assert.equal(adjusted.status, "MATURED");
      assert.equal(adjusted.collectionBonus.weightMg, 350);
      assert.equal((await getPassbook({ ...req, params: { schemeId: scheme._id } })).collectionBonus.weightMg, 350);
      const adjustment = await LedgerEntry.findOne({ schemeId: scheme._id, type: "MATURITY_GOLD_ADJUSTMENT" });
      assert.equal(adjustment.weightMg, -350);
      assert.equal(await LedgerEntry.countDocuments({ schemeId: scheme._id, type: "MATURITY_GOLD_CREDIT" }), 1);
    } finally {
      resetCalendarDateOverrideForTests();
      await stopTestDb();
    }
  });
}


test("expired and closed bonuses agree with maturity-board status filters", async () => {
  await startTestDb();
  await resetTestDb();
  try {
    const { tenant, branch } = await seedTenantUser();
    const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
    const planSnapshot = { benefit: { type: "MATURITY_GOLD_CREDIT", goldBonus: {
      bonusBasis: "NET_PAID_AT_MATURITY_RATE", bonusPercent: 7, requireAllCollections: true,
    } } };
    const scope = { tenantId: tenant._id, branchId: branch._id };
    for (const [index, status] of ["ENROLMENT_EXPIRED", "CLOSED_PREMATURE"].entries()) {
      const closed = await Scheme.create({
        ...scope, customerId: customer._id, planId: "plan_terminal_gold", enrollmentNumber: `GOLD-END-${index}`,
        planSnapshot, startDate: "2026-01-01", maturityDate: "2026-06-30", status, paymentPattern: "FIXED", valueBasis: "GOLD_WEIGHT",
        ...(index ? { collectionBonus: { status: "PENDING_RATE", weightMg: 0 } } : {}),
      });
      assert.equal(mapCustomerSchemeDetail(closed.toObject()).collectionBonus.status, "INELIGIBLE");
      assert.equal(await Scheme.countDocuments({ _id: closed._id, ...collectionListFilters({ bonusStatus: "INELIGIBLE" }) }), 1);
      assert.equal(await Scheme.countDocuments({ _id: closed._id, ...collectionListFilters({ bonusStatus: "PENDING_RATE" }) }), 0);
    }
  } finally {
    await stopTestDb();
  }
});

test("gold and rupee bonus arithmetic agrees with exact rational rounding", () => {
  const roundingModes = ["ROUND_DOWN", "HALF_UP", "ROUND_UP"];
  const bases = ["NET_GOLD_WEIGHT", "NET_PAID_AT_MATURITY_RATE"];
  let checked = 0;
  let seed = 761_352n;
  function next() {
    seed = (seed * 48_271n) % 2_147_483_647n;
    return seed;
  }
  for (let i = 0; i < 500; i++) {
    const paid = next() * (next() % 1_000_000n);
    const gold = next() % 100_000_000n;
    const rate = 200_000n + next() % 2_000_000n;
    const percent = i % 100 + 1;
    for (const basis of bases) {
      const normalisedPercent = BigInt(percent);
      const numerator = basis === "NET_GOLD_WEIGHT" ? gold * normalisedPercent : (paid * normalisedPercent / 100n) * 1000n;
      const baseDenominator = basis === "NET_GOLD_WEIGHT" ? 100n : rate;
      for (const precision of [1, 5, 100, 1000]) {
        const denominator = baseDenominator * BigInt(precision);
        const quotient = numerator / denominator;
        const remainder = numerator % denominator;
        for (const mode of roundingModes) {
          const roundUp = mode === "ROUND_UP" ? remainder > 0n : mode === "HALF_UP" && remainder * 2n >= denominator;
          const expected = Number((quotient + BigInt(roundUp)) * BigInt(precision));
          assert.equal(collectionBonusWeight({ bonusBasis: basis, bonusPercent: percent }, {
            goldWeightMg: Number(gold), amountPaidPaise: Number(paid),
          }, { weightPrecisionMg: precision, weightRoundingMode: mode }, Number(rate)), expected);
          checked += 1;
        }
      }
    }
  }
  assert.equal(checked, 12_000);
  for (const [mode, expected] of [["ROUND_DOWN", 0], ["HALF_UP", 10], ["ROUND_UP", 10]]) {
    assert.equal(collectionBonusWeight({ bonusBasis: "NET_GOLD_WEIGHT", bonusPercent: 50 }, { goldWeightMg: 10 },
      { weightPrecisionMg: 10, weightRoundingMode: mode }), expected);
  }
});
