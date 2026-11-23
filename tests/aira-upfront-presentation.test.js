import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAiraCollectionPlan,
  buildAiraUpfrontPlan,
  STANDARD_COLLECTION_PLAN_DEFS,
} from "../scripts/lib/collection-gold-plan-seed.js";
import { mapCustomerPlanListItem } from "../src/lib/customer-app-dto.js";
import { mapCustomerSchemeDetail } from "../src/lib/customer-scheme-detail-dto.js";
import { oneTimeCreditWeight } from "../src/lib/one-time-gold-schedule.js";
import { validateCompletePlan } from "../src/lib/plan-merge.js";
import { previewSchedule } from "../src/services/plan.service.js";

test("Aira upfront has one payment and twelve separate monthly gold credits", async () => {
  const plan = validateCompletePlan(buildAiraUpfrontPlan({ maximumUpfrontPaise: 50_000_000 }));
  const dto = mapCustomerPlanListItem(plan);
  assert.equal(dto.paymentPatternLabel, "One upfront payment");
  assert.equal(dto.installmentCount, 1);
  assert.equal(dto.enrol.minInstallment.amountPaise, 10_000_000);
  assert.deepEqual(dto.highlights, ["One full payment at enrolment", "2% of principal gold credited monthly"]);
  const fundedOn = "2028-01-31";
  const { summary, schedule } = await previewSchedule({ ...plan, startDate: fundedOn });
  assert.equal(schedule.length, 1);
  assert.equal(summary.totalPayable.amountPaise, 10_000_000);
  assert.equal(summary.oneTimeSchedule.length, 12);
  assert.equal(summary.oneTimeSchedule[0].dueDate, "2028-02-29");
  assert.equal(summary.maturityDate, "2029-01-31");

  const periods = summary.oneTimeSchedule.map((row, index) => {
    const weightMg = oneTimeCreditWeight({
      rules: plan.oneTimeRules, count: 12, period: row.period,
      principal: { amountPaidPaise: 10_000_000, goldWeightMg: 10_000 },
      originalPaidPaise: 10_000_000, goldRules: plan.goldRules,
    });
    assert.equal(weightMg, 200);
    return index === 0 ? { ...row, status: "CREDITED", weightMg } : row;
  });
  const detail = mapCustomerSchemeDetail({
    status: "ACTIVE", paymentPattern: "FIXED", valueBasis: "GOLD_WEIGHT",
    planSnapshot: plan, maturityDate: summary.maturityDate,
    installments: [{ number: 1, dueDate: fundedOn, amountPaise: 10_000_000, paidPaise: 10_000_000, status: "PAID" }],
    totals: { amountPaidPaise: 10_000_000, goldWeightMg: 10_000 },
    oneTimeGold: { fundedOn, originalPaidPaise: 10_000_000, periods, nextCreditDate: periods[1].dueDate },
  });
  assert.equal(detail.progressLabel, "1 of 12 gold credits posted");
  assert.equal(detail.nextActionLabel, "Next gold credit · 2028-03-31");
  assert.equal(detail.oneTimeProgress.creditedWeightMg, 200);
  assert.equal(detail.installmentSchedule.length, 1);
  assert.equal(detail.payButton.visible, false);
  assert.equal(detail.payButton.enabled, false);
});

test("collection plans advertise their frequencies and maturity credit", () => {
  for (const definition of STANDARD_COLLECTION_PLAN_DEFS) {
    const dto = mapCustomerPlanListItem(buildAiraCollectionPlan(definition));
    assert.equal(dto.paymentPatternLabel, "Scheduled collections");
    assert.deepEqual(dto.collectionRules.frequencies, ["DAILY", "WEEKLY", "MONTHLY"]);
    assert.equal(dto.benefitLabel, `${definition.bonusPercent}% additional gold at maturity`);
  }
});
