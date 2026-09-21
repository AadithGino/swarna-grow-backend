import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceInstallmentWindowCount,
  computeFixedPaymentQuote,
  isFixedPaymentAmountAllowed,
} from "../src/lib/fixed-payment-policy.js";

const installments = [
  { number: 1, amountPaise: 100000, paidPaise: 100000, status: "PAID" },
  { number: 2, amountPaise: 100000, paidPaise: 0, status: "DUE" },
  { number: 3, amountPaise: 100000, paidPaise: 0, status: "PENDING" },
  { number: 4, amountPaise: 100000, paidPaise: 0, status: "PENDING" },
];

test("partial disabled allows only exact installment sums", () => {
  const quote = computeFixedPaymentQuote(
    { installments },
    { partialPaymentAllowed: false, advancePaymentAllowed: true, maxAdvanceInstallments: 2 },
  );
  assert.deepEqual(quote.allowedAmountsPaise, [100000, 200000, 300000]);
  assert.equal(isFixedPaymentAmountAllowed(quote, 150000), false);
  assert.equal(isFixedPaymentAmountAllowed(quote, 200000), true);
});

test("advance disabled allows only current installment remainder", () => {
  const quote = computeFixedPaymentQuote(
    { installments },
    { partialPaymentAllowed: false, advancePaymentAllowed: false },
  );
  assert.deepEqual(quote.allowedAmountsPaise, [100000]);
});

test("maxAdvanceInstallments 0 with advance enabled is current only", () => {
  assert.equal(
    advanceInstallmentWindowCount({ advancePaymentAllowed: true, maxAdvanceInstallments: 0 }),
    1,
  );
  const quote = computeFixedPaymentQuote(
    { installments },
    { partialPaymentAllowed: false, advancePaymentAllowed: true, maxAdvanceInstallments: 0 },
  );
  assert.deepEqual(quote.allowedAmountsPaise, [100000]);
});

test("reserved capacity reduces allowed exact amounts", () => {
  const quote = computeFixedPaymentQuote(
    { installments },
    { partialPaymentAllowed: false, advancePaymentAllowed: true, maxAdvanceInstallments: 1 },
    { reservedPaise: 100_000 },
  );
  assert.deepEqual(quote.allowedAmountsPaise, [100_000]);
  assert.equal(quote.reservedPaise, 100_000);
});
