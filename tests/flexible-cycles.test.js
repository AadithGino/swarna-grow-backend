import test from "node:test";
import assert from "node:assert/strict";
import { payableRange } from "../src/services/scheme.service.js";
import { monthKey } from "../src/lib/date.js";

const req = (targetCycle, body = {}) => ({ query: { targetCycle }, body, auth: { tenantId: "tnt_1", type: "CUSTOMER", id: "cus_1" } });
const currentCycle = monthKey();
function shiftMonth(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
const nextCycle = shiftMonth(currentCycle, 1);
const cyclePlus2 = shiftMonth(currentCycle, 2);
const cyclePlus3 = shiftMonth(currentCycle, 3);

function cappedScheme({ paidPaise = 0, capPaise = 250000, rules = {} } = {}) {
  const remainingPaise = Math.max(0, capPaise - paidPaise);
  return {
    _id: "sch_cap", tenantId: "tnt_1", customerId: "cus_1", status: "LOCKED", paymentPattern: "FLEXIBLE", flexiblePhase: "CAPPED", positionVersion: 1,
    cycles: [{ cycle: currentCycle, capPaise, paidPaise, remainingPaise, status: remainingPaise ? "PARTIALLY_PAID" : "PAID", expiresAt: `${currentCycle}-28` }],
    planSnapshot: {
      flexibleRules: {
        cappedPhase: {
          minimumPaymentPaise: 100000,
          paymentIncrementPaise: 10000,
          allowFinalRemainderBelowMinimum: true,
          allowFutureCyclePayment: false,
          maxAdvanceCycles: 0,
          ...rules,
        },
      },
    },
  };
}

function futureScheme({ allowFuture = true, maxAdvance = 2, currentRemaining = 0, nextRemaining = 250000, plus2Remaining = 300000 } = {}) {
  return {
    _id: "sch_future", tenantId: "tnt_1", customerId: "cus_1", status: "LOCKED", paymentPattern: "FLEXIBLE", flexiblePhase: "CAPPED", positionVersion: 0,
    cycles: [
      { cycle: currentCycle, capPaise: 250000, paidPaise: 250000 - currentRemaining, remainingPaise: currentRemaining, status: currentRemaining ? "PARTIALLY_PAID" : "PAID" },
      { cycle: nextCycle, capPaise: 250000, paidPaise: 250000 - nextRemaining, remainingPaise: nextRemaining, status: nextRemaining ? (nextRemaining < 250000 ? "PARTIALLY_PAID" : "UPCOMING") : "PAID" },
      { cycle: cyclePlus2, capPaise: 300000, paidPaise: 300000 - plus2Remaining, remainingPaise: plus2Remaining, status: plus2Remaining ? "UPCOMING" : "PAID" },
      { cycle: cyclePlus3, capPaise: 300000, paidPaise: 0, remainingPaise: 300000, status: "UPCOMING" },
    ],
    planSnapshot: { flexibleRules: { cappedPhase: { minimumPaymentPaise: 100000, paymentIncrementPaise: 10000, allowFinalRemainderBelowMinimum: true, allowFutureCyclePayment: allowFuture, maxAdvanceCycles: maxAdvance } } },
  };
}

test("multiple payments within one cycle reduce remaining allowance without carry-forward", async () => {
  const first = await payableRange(req(currentCycle), cappedScheme({ paidPaise: 0, capPaise: 250000 }));
  assert.equal(first.maxPayablePaise, 250000);
  assert.equal(first.unusedAllowanceCarriesForward, false);
  const afterPartial = await payableRange(req(currentCycle), cappedScheme({ paidPaise: 100000, capPaise: 250000 }));
  assert.equal(afterPartial.maxPayablePaise, 150000);
  assert.equal(afterPartial.contributionIsOptional, true);
});

test("final remainder below minimum is allowed when configured", async () => {
  const quote = await payableRange(req(currentCycle), cappedScheme({ paidPaise: 190000, capPaise: 250000 }));
  assert.equal(quote.maxPayablePaise, 60000);
  assert.equal(quote.minPayablePaise, 60000);
  assert.equal(quote.allowFinalRemainderBelowMinimum, true);
});

test("expired cycle capacity is not payable later", async () => {
  const past = shiftMonth(currentCycle, -1);
  const scheme = cappedScheme({ paidPaise: 0, capPaise: 250000 });
  scheme.cycles = [{ cycle: past, capPaise: 250000, paidPaise: 0, remainingPaise: 250000, status: "EXPIRED", expiresAt: `${past}-28` }];
  await assert.rejects(() => payableRange(req(past), scheme), (error) => error.code === "CYCLE_CLOSED");
});

test("future cycle rejects when allowFutureCyclePayment is false", async () => {
  await assert.rejects(() => payableRange(req(nextCycle), futureScheme({ allowFuture: false })), (error) => error.code === "FUTURE_CYCLE_PAYMENT_NOT_ALLOWED");
});

test("future cycle rejects when current cycle still has remainingPaise", async () => {
  await assert.rejects(() => payableRange(req(nextCycle), futureScheme({ currentRemaining: 50000 })), (error) => error.code === "CURRENT_CYCLE_INCOMPLETE");
});

test("future cycle rejects when an intermediate cycle still has remaining allowance", async () => {
  await assert.rejects(() => payableRange(req(cyclePlus2), futureScheme({ nextRemaining: 10000 })), (error) => error.code === "CYCLE_SEQUENCE_VIOLATION");
});

test("future cycle rejects when monthDistance exceeds maxAdvanceCycles", async () => {
  await assert.rejects(() => payableRange(req(cyclePlus3), futureScheme({ maxAdvance: 2, nextRemaining: 0, plus2Remaining: 0 })), (error) => error.code === "ADVANCE_CYCLE_LIMIT_EXCEEDED");
});

test("future cycle happy path quotes the target cycle's own cap", async () => {
  const quote = await payableRange(req(nextCycle), futureScheme());
  assert.equal(quote.payable, true);
  assert.equal(quote.targetCycle, nextCycle);
  assert.equal(quote.maxPayablePaise, 250000);
  assert.equal(quote.capPaise, 250000);
});
