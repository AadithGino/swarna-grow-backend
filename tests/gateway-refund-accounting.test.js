import test from "node:test";
import assert from "node:assert/strict";
import { cumulativeRefundWeightMg, refundWeightDeltaMg } from "../src/lib/gateway-refund-accounting.js";

test("25% refund weight uses floor ratio", () => {
  const delta = refundWeightDeltaMg({
    originalPaymentWeightMg: 1000,
    originalPaymentAmountPaise: 100_000,
    priorRefundedAmountPaise: 0,
    priorRefundedWeightMg: 0,
    refundAmountPaise: 25_000,
  });
  assert.equal(delta, 250);
});

test("final remainder refund reverses exact remaining weight", () => {
  const first = refundWeightDeltaMg({
    originalPaymentWeightMg: 1000,
    originalPaymentAmountPaise: 100_000,
    priorRefundedAmountPaise: 0,
    priorRefundedWeightMg: 0,
    refundAmountPaise: 25_000,
  });
  const second = refundWeightDeltaMg({
    originalPaymentWeightMg: 1000,
    originalPaymentAmountPaise: 100_000,
    priorRefundedAmountPaise: 25_000,
    priorRefundedWeightMg: first,
    refundAmountPaise: 75_000,
  });
  assert.equal(first + second, 1000);
});

test("cumulativeRefundWeightMg full refund equals original weight", () => {
  assert.equal(
    cumulativeRefundWeightMg({
      originalPaymentWeightMg: 333,
      originalPaymentAmountPaise: 99_999,
      cumulativeRefundPaise: 99_999,
    }),
    333,
  );
});
