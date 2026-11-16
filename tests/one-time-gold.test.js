import test from "node:test";
import assert from "node:assert/strict";
import { GoldRate, LedgerEntry, Scheme } from "../src/models/index.js";
import { buildOneTimeGoldSchedule, oneTimeCreditWeight } from "../src/lib/one-time-gold-schedule.js";
import { calendarDayYmd } from "../src/lib/reminder-timezone.js";
import { resetCalendarDateOverrideForTests, setCalendarDateOverrideForTests } from "../src/lib/date.js";
import { createPlan, previewSchedule } from "../src/services/plan.service.js";
import { previewScheduleBody } from "../src/validators/common.validators.js";
import { getScheme, enrol, payableRange } from "../src/services/scheme.service.js";
import { runMaturityTransitionBatch } from "../src/services/scheme-maintenance.service.js";
import { releaseHandoverOtp, requestCustomerRedemption, revealCustomerHandoverOtp, settlementPreview, transitionRedemption } from "../src/services/redemption.service.js";
import { reversePayment } from "../src/services/payment.service.js";
import { Payment } from "../src/models/index.js";
import { seedTenantUser, seedCustomer, startTestDb, stopTestDb, resetTestDb } from "./helpers/db.js";

test("monthly anniversaries clamp independently and rounded weight totals reconcile", () => {
  const rules = { timing: "MONTHLY", basis: "PRINCIPAL_PERCENT", value: 7, amountPeriod: "TERM_TOTAL" };
  const rows = buildOneTimeGoldSchedule({ durationMonths: 3, oneTimeRules: rules }, "2028-01-31");
  assert.deepEqual(rows.map((row) => row.dueDate), ["2028-02-29", "2028-03-31", "2028-04-30"]);
  assert.equal(rows.reduce((sum, row) => sum + oneTimeCreditWeight({
    rules, period: row.period, count: 3, principal: { goldWeightMg: 10000, amountPaidPaise: 1_000_000 },
    originalPaidPaise: 1_000_000,
  }), 0), 700);
});

for (const [timing, mode, basis] of [
  ["MONTHLY", "CASH", "PRINCIPAL_PERCENT"],
  ["AT_MATURITY", "CASH", "PRINCIPAL_PERCENT"],
  ["AT_MATURITY", "GOLD_HANDOVER", "FIXED_WEIGHT_MG"],
  ["MONTHLY", "PURCHASE_ADJUSTMENT", "RUPEE_PAISE"],
]) {
  test(`${timing} ${mode}: one funding payment, atomic credits and settlement`, async () => {
    await startTestDb();
    await resetTestDb();
    try {
      const start = calendarDayYmd();
      setCalendarDateOverrideForTests(start);
      const { tenant, branch, user } = await seedTenantUser();
      const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
      const req = { auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER", role: user.role },
        scope: { tenantId: tenant._id, branchId: branch._id }, tenant: tenant.toObject(), baseUrl: "/api/v1/admin", headers: {}, ip: "127.0.0.1", query: {} };
      const bonus = basis === "RUPEE_PAISE" ? 300 : 700;
      const planBody = {
        name: "One-time Gold", code: "ONETIME", paymentPattern: "FIXED", valueBasis: "GOLD_WEIGHT",
        durationMonths: 3, installmentCount: 1, status: "ACTIVE",
        oneTimeRules: { timing, basis, amountPeriod: "TERM_TOTAL", value: basis === "RUPEE_PAISE" ? 210_000 : basis === "FIXED_WEIGHT_MG" ? 700 : 7 },
        amountRules: { amountMode: "JEWELLER_FIXED", fixedAmountPaise: 6_000_000 },
        scheduleRules: { dueDateRule: "JOIN_ANNIVERSARY", firstInstallmentModeDefault: "COLLECT_NOW", firstInstallmentModeEditable: false, graceDays: 0 },
        paymentRules: { partialPaymentAllowed: false, advancePaymentAllowed: false, maxAdvanceInstallments: 0 },
        goldRules: { weightRoundingMode: "HALF_UP", weightPrecisionMg: 1, blockPaymentIfRateNotSet: true, rateSource: "TENANT_DAILY_RATE" },
        redemptionRules: { allowedModes: [mode], prematureClosureAllowed: false, lockInMonths: 3, redeemAtAnyBranch: false, prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" } },
        availability: { allBranches: true, branchIds: [], visibleInCustomerApp: true, customerSelfEnrolAllowed: true },
      };
      const sample = {
        installmentAmountPaise: 6_000_000,
        startDate: "2028-01-31",
      };
      const draftPreview = await previewSchedule(previewScheduleBody.parse({ ...planBody, ...sample }));
      assert.deepEqual(draftPreview.schedule.map((row) => row.dueDate), ["2028-01-31"]);
      assert.equal(draftPreview.summary.totalPayable.amountPaise, sample.installmentAmountPaise);
      assert.equal(draftPreview.summary.maturityDate, "2028-04-30");
      assert.deepEqual(draftPreview.summary.oneTimeRules, planBody.oneTimeRules);
      assert.deepEqual(draftPreview.summary.oneTimeSchedule.map((row) => row.dueDate),
        timing === "MONTHLY" ? ["2028-02-29", "2028-03-31", "2028-04-30"] : ["2028-04-30"]);
      const plan = await createPlan({ ...req, body: planBody });
      const savedPreview = await previewSchedule(previewScheduleBody.parse({ ...sample, planId: plan._id }), tenant._id);
      assert.deepEqual(savedPreview.summary.oneTimeSchedule, draftPreview.summary.oneTimeSchedule);
      await GoldRate.create({ tenantId: tenant._id, branchId: branch._id, effectiveDate: start, ratePerGramPaise: 600_000 });
      const enrolled = await enrol({ ...req, body: {
        customerId: customer._id, planId: plan._id, firstInstallmentMode: "COLLECT_NOW",
        firstInstallmentAction: "RECORD_MANUAL_PAYMENT", payment: { amountPaise: 6_000_000, mode: "UPI" },
      } });
      const adminReq = { ...req, params: { schemeId: enrolled._id }, body: { mode } };
      const funded = await getScheme(adminReq);
      assert.equal(funded.oneTimeProgress.principalWeightMg, 10000);
      assert.equal(funded.oneTimeProgress.periods.length, timing === "MONTHLY" ? 3 : 1);
      await assert.rejects(payableRange(adminReq), { code: "PAYMENT_POSITION_CLOSED" }).catch(async () => {
        assert.equal((await payableRange(adminReq)).payable, false);
      });
      if (timing === "MONTHLY" && basis === "PRINCIPAL_PERCENT") {
        await runMaturityTransitionBatch({ today: funded.oneTimeProgress.periods[0].dueDate });
        assert.equal((await getScheme(adminReq)).oneTimeProgress.redeemableBonusWeightMg, 0);
        assert.equal((await getScheme(adminReq)).oneTimeProgress.creditedWeightMg, 233);
      }
      const maturityDate = funded.maturityDate;
      if (basis === "RUPEE_PAISE") {
        await runMaturityTransitionBatch({ today: maturityDate });
        const blocked = await getScheme(adminReq);
        assert.equal(blocked.status, "ACTIVE");
        assert.ok(blocked.oneTimeProgress.periods.every((row) => row.status === "PENDING_RATE"));
        await GoldRate.create(funded.oneTimeProgress.periods.map((row) => ({
          tenantId: tenant._id, branchId: branch._id, effectiveDate: row.dueDate, ratePerGramPaise: 700_000,
        })));
      }
      await Promise.all([runMaturityTransitionBatch({ today: maturityDate }), runMaturityTransitionBatch({ today: maturityDate })]);
      const matured = await getScheme(adminReq);
      assert.equal(matured.status, "MATURED");
      assert.equal(matured.oneTimeProgress.redeemableBonusWeightMg, bonus);
      setCalendarDateOverrideForTests(maturityDate);
      if (basis !== "RUPEE_PAISE") await GoldRate.create({ tenantId: tenant._id, branchId: branch._id, effectiveDate: maturityDate, ratePerGramPaise: 700_000 });
      const quote = await settlementPreview(adminReq, "MATURITY_REDEMPTION");
      assert.equal(quote.eligible, true, JSON.stringify(quote.blockers));
      assert.equal(quote.benefitWeightMg, bonus);
      const expectedSettlement = (10_000 + bonus) * 700;
      assert.equal(quote.settlementPaise, expectedSettlement);
      if (timing === "AT_MATURITY" || mode !== "CASH") {
        const customerAuth = { id: customer._id, tenantId: tenant._id, type: "CUSTOMER" };
        const correction = await requestCustomerRedemption({
          ...adminReq, auth: customerAuth, scope: { tenantId: tenant._id },
          body: { preferredMode: mode, expectedVersion: matured.version,
            ...(mode === "PURCHASE_ADJUSTMENT" ? { modeDetails: { billNumber: "BILL-001" } } : {}) },
        });
        const redemption = { ...req, params: { redemptionId: correction.id }, body: {} };
        await transitionRedemption(redemption, "approve");
        await releaseHandoverOtp(redemption);
        const { handoverOtp } = await revealCustomerHandoverOtp({ ...redemption, auth: customerAuth });
        const completed = await transitionRedemption({ ...redemption, body: { handoverOtp } }, "complete");
        assert.equal(completed.cashOutPaise, mode === "CASH" ? expectedSettlement : 0);
        assert.equal(await LedgerEntry.countDocuments({ schemeId: enrolled._id, type: "BENEFIT_CREDIT" }), 0);
        return;
      }
      const payment = await Payment.findOne({ schemeId: enrolled._id });
      await reversePayment({ ...req, params: { paymentId: payment._id }, body: { reason: "Funding reversed" } });
      const reversed = await Scheme.findById(enrolled._id).lean();
      assert.equal(reversed.status, "CLOSED_PREMATURE");
      assert.equal(await LedgerEntry.countDocuments({ schemeId: enrolled._id, type: "MATURITY_GOLD_ADJUSTMENT", weightMg: -700 }), 1);
    } finally {
      resetCalendarDateOverrideForTests();
      await stopTestDb();
    }
  });
}
