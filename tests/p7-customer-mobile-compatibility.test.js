process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import { deriveSellPaymentDisplayState } from "../src/lib/digital-metals-sell-payment-state.js";

test("sell payment display: previous pending requests remain identifiable for review", () => {
  const state = deriveSellPaymentDisplayState({ sellStatus: "PENDING_APPROVAL", payable: null, payouts: [] });
  assert.equal(state.key, "AWAITING_ACCEPTANCE");
  assert.match(state.label, /review/i);
});

test("sell payment display: unpaid after accept", () => {
  const state = deriveSellPaymentDisplayState({
    sellStatus: "PAYABLE_OPEN",
    payable: { status: "OPEN", amountPaise: 10_000, outstandingPaise: 10_000 },
    payouts: [],
  });
  assert.equal(state.key, "UNPAID");
});

test("sell payment display: partially paid", () => {
  const state = deriveSellPaymentDisplayState({
    sellStatus: "PAYABLE_OPEN",
    payable: { status: "OPEN", amountPaise: 10_000, outstandingPaise: 4_000 },
    payouts: [],
  });
  assert.equal(state.key, "PARTIALLY_PAID");
});

test("sell payment display: paid when settled", () => {
  const state = deriveSellPaymentDisplayState({
    sellStatus: "PAYABLE_OPEN",
    payable: { status: "SETTLED", amountPaise: 10_000, outstandingPaise: 0 },
    payouts: [],
  });
  assert.equal(state.key, "PAID");
});

test("sell payment display: payment being checked when payout in flight", () => {
  const state = deriveSellPaymentDisplayState({
    sellStatus: "PAYABLE_OPEN",
    payable: { status: "OPEN", amountPaise: 10_000, outstandingPaise: 10_000 },
    payouts: [{ status: "SUBMITTED" }],
  });
  assert.equal(state.key, "PAYMENT_BEING_CHECKED");
});

test("reserved sale needs customer confirmation rather than staff acceptance", () => {
  const state = deriveSellPaymentDisplayState({ sellStatus: "RESERVED", payable: null });
  assert.equal(state.key, "AWAITING_CONFIRMATION");
  assert.equal(state.label, "Confirm sale");
});
