import test from "node:test";
import assert from "node:assert/strict";
import { mapCustomerSchemeDetail, mapHomeSchemeCard } from "../src/lib/customer-scheme-detail-dto.js";
import { enrichPayableRange, derivePaymentUiState } from "../src/lib/customer-app-dto.js";
import { today } from "../src/lib/date.js";

test("home scheme card — flexible totalPaid uses cycles when list totals are zero", () => {
  const card = mapHomeSchemeCard({
    _id: "sch_flex_list",
    enrollmentNumber: "ENR-0000010",
    paymentPattern: "FLEXIBLE",
    flexiblePhase: "FLEXIBLE",
    status: "ACTIVE",
    startDate: "2026-09-01",
    maturityDate: "2026-12-01",
    planSnapshot: {
      name: "Flexible then capped",
      flexibleRules: { flexiblePhase: { minimumPaymentPaise: 10000, maximumPaymentPaise: 500000 }, flexiblePhaseCycles: 3 },
    },
    totals: { amountPaidPaise: 0 },
    cycles: [{ cycle: "2026-09", paidPaise: 200_000, capPaise: 0, status: "PARTIALLY_PAID" }],
  });
  assert.equal(card.totalPaid.amountPaise, 200_000);
  assert.match(card.totalPaid.amountDisplay, /₹/);
});

test("home scheme card — includes UI money and progress fields", () => {
  const card = mapHomeSchemeCard({
    _id: "sch_home",
    enrollmentNumber: "ENR-0000099",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    maturityDate: "2027-06-01",
    planSnapshot: { name: "Akshaya", benefit: { type: "ONE_FREE_INSTALLMENT" } },
    installments: [
      { number: 1, dueDate: "2026-02-01", amountPaise: 300000, paidPaise: 300000, status: "PAID" },
      { number: 2, dueDate: "2026-03-01", amountPaise: 300000, paidPaise: 0, status: "DUE" },
    ],
  });
  assert.equal(card.id, "sch_home");
  assert.equal(card.totalPaid.amountPaise, 300000);
  assert.equal(card.totalPaid.amountDisplay.length > 0, true);
  assert.equal(card.progressPercent, 50);
  assert.ok(card.nextActionAmount?.amountPaise);
  assert.equal(typeof card.canPay, "boolean");
});

test("scheme detail DTO — FIXED display mode", () => {
  const dto = mapCustomerSchemeDetail({
    _id: "sch_fixed",
    enrollmentNumber: "ENR-0000001",
    planId: "plan_1",
    planSnapshot: { name: "Fixed 11" },
    paymentPattern: "FIXED",
    displayMode: "FIXED",
    status: "ACTIVE",
    uiStatus: "ACTIVE",
    maturityDate: "2027-01-01",
    startDate: "2026-01-01",
    version: 2,
    positionVersion: 0,
    installments: [
      { number: 1, dueDate: "2026-02-01", amountPaise: 500000, paidPaise: 500000, status: "PAID" },
      { number: 2, dueDate: "2026-03-01", amountPaise: 500000, paidPaise: 0, status: "DUE" },
    ],
    totals: { amountPaidPaise: 500000, goldWeightMg: 0 },
    actions: { canRecordPayment: true, canRedeem: false },
    passbook: { totals: { paid: { amountPaise: 500000 }, pending: { amountPaise: 500000 }, installmentsPaid: 1, installmentsTotal: 11 } },
  });
  assert.equal(dto.displayMode, "FIXED");
  assert.equal(dto.progressCard.type, "FIXED");
  assert.equal(dto.progressCard.installmentsPaid, 1);
  assert.equal(dto.payButton.enabled, true);
  assert.equal(dto.payButton.visible, true);
  assert.equal(dto.totalPaid.amountPaise, 500000);
  assert.ok(dto.header.eyebrow);
  assert.ok(Array.isArray(dto.statCards));
  assert.equal(typeof dto.statCards[0].value, "string");
});

test("free window progress — start day shows 0% and no completed months", () => {
  const start = today();
  const card = mapHomeSchemeCard({
    _id: "sch_new",
    enrollmentNumber: "ENR-0000099",
    planSnapshot: {
      name: "Flex plan",
      flexibleRules: { flexiblePhaseCycles: 3 },
    },
    paymentPattern: "FLEXIBLE",
    flexiblePhase: "FLEXIBLE",
    status: "ACTIVE",
    startDate: start,
    totals: { amountPaidPaise: 0 },
  });
  assert.equal(card.displayMode, "FLEXIBLE_FREE_WINDOW");
  assert.equal(card.progressPercent, 0);
});

test("scheme detail DTO — FLEXIBLE free window", () => {
  const dto = mapCustomerSchemeDetail({
    _id: "sch_flex",
    enrollmentNumber: "ENR-0000002",
    planSnapshot: { name: "Flex plan", flexibleRules: { flexiblePhase: { minimumPaymentPaise: 10000, maximumPaymentPaise: 500000 }, flexiblePhaseCycles: 6 } },
    displayMode: "FLEXIBLE_FREE_WINDOW",
    status: "ACTIVE",
    totals: { amountPaidPaise: 120000, goldWeightMg: 100 },
    actions: { canRecordPayment: true, canRedeem: false },
  });
  assert.equal(dto.displayMode, "FLEXIBLE_FREE_WINDOW");
  assert.equal(dto.progressCard.type, "FLEXIBLE_FREE_WINDOW");
  assert.match(dto.helperText ?? "", /optional/i);
});

test("scheme detail DTO — GOLD_WEIGHT includes zero gold balance", () => {
  const dto = mapCustomerSchemeDetail({
    _id: "sch_gold",
    enrollmentNumber: "ENR-0000028",
    planSnapshot: { name: "11+1 Gold weight", valueBasis: "GOLD_WEIGHT" },
    valueBasis: "GOLD_WEIGHT",
    paymentPattern: "FIXED",
    displayMode: "FIXED",
    status: "ACTIVE",
    totals: { amountPaidPaise: 0, goldWeightMg: 0 },
    actions: { canRecordPayment: true, canRedeem: false },
    installments: [{ number: 1, dueDate: "2026-10-17", amountPaise: 500000, paidPaise: 0, status: "DUE" }],
  });
  assert.equal(dto.goldAccumulated?.weightMg, 0);
  assert.equal(dto.goldAccumulated?.weightDisplay, "0.000 g");
  assert.equal(dto.progressCard.goldAccumulated?.weightDisplay, "0.000 g");
  assert.equal(dto.statCards[0].label, "Gold accumulated");
  assert.equal(dto.statCards[0].value, "0.000 g");
});

test("scheme detail DTO — FLEXIBLE capped window", () => {
  const dto = mapCustomerSchemeDetail({
    _id: "sch_cap",
    enrollmentNumber: "ENR-0000003",
    displayMode: "FLEXIBLE_LOCK_WINDOW",
    status: "LOCKED",
    lockedAveragePaise: 200000,
    cycles: [{ cycle: "2026-03", capPaise: 200000, paidPaise: 50000, remainingPaise: 150000, status: "PARTIALLY_PAID" }],
    totals: { amountPaidPaise: 900000, goldWeightMg: 0 },
    actions: { canRecordPayment: true, canRedeem: false },
  });
  assert.equal(dto.displayMode, "FLEXIBLE_LOCK_WINDOW");
  assert.equal(dto.progressCard.type, "FLEXIBLE_LOCK_WINDOW");
  assert.equal(dto.progressCard.remainingThisCycle.amountPaise, 150000);
  assert.equal(dto.progressCard.paidThisCycle.amountPaise, 50000);
});

test("payable range — maxPayable equals remainingThisCycle in capped phase", () => {
  const enriched = enrichPayableRange(
    {
      model: "FLEXIBLE",
      phase: "CAPPED",
      contributionIsOptional: true,
      targetCycle: "2026-03",
      minPayablePaise: 50000,
      maxPayablePaise: 150000,
      remainingPaise: 150000,
      capPaise: 200000,
      paidPaise: 50000,
      paymentIncrementPaise: 100,
      positionVersion: 12,
      payable: true,
      maxReason: null,
      nextCycleAction: "PAY_CURRENT_CYCLE",
    },
    { positionVersion: 12 },
  );
  assert.equal(enriched.maxPayable.amountPaise, 150000);
  assert.equal(enriched.remainingThisCycle.amountPaise, 150000);
  assert.equal(enriched.cycleCap.amountPaise, 200000);
  assert.equal(enriched.paidThisCycle.amountPaise, 50000);
  assert.equal(enriched.positionVersion, 12);
});

test("public payment poll terminal states", () => {
  assert.equal(derivePaymentUiState({ status: "EXPIRED" }, null), "EXPIRED");
  assert.equal(derivePaymentUiState({ status: "CANCELLED" }, { status: "FAILED" }), "CANCELLED");
  assert.equal(derivePaymentUiState({ status: "OPENED" }, { status: "PENDING" }), "PROCESSING");
  assert.equal(derivePaymentUiState({ status: "PAID" }, { status: "SUCCESS" }), "PAID");
});
