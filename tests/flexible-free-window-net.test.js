import test from "node:test";
import assert from "node:assert/strict";
import { summarizeFreeWindowLedgerNet } from "../src/lib/flexible-free-window-net.js";

test("full reversal excludes payment from net total and count", () => {
  const summary = summarizeFreeWindowLedgerNet([
    { type: "FREE_WINDOW_PAYMENT", paymentId: "pay_1", amountPaise: 100000 },
    { type: "REVERSAL", reversalOf: "pay_1", amountPaise: 100000 },
    { type: "FREE_WINDOW_PAYMENT", paymentId: "pay_2", amountPaise: 50000 },
  ]);
  assert.equal(summary.netTotalPaise, 50000);
  assert.equal(summary.netPositivePaymentCount, 1);
});

test("multiple free-window payments sum net total and count", () => {
  const summary = summarizeFreeWindowLedgerNet([
    { type: "FREE_WINDOW_PAYMENT", paymentId: "pay_a", amountPaise: 40000 },
    { type: "FREE_WINDOW_PAYMENT", paymentId: "pay_b", amountPaise: 60000 },
    { type: "FREE_WINDOW_PAYMENT", paymentId: "pay_c", amountPaise: 25000 },
  ]);
  assert.equal(summary.netTotalPaise, 125000);
  assert.equal(summary.netPositivePaymentCount, 3);
});

test("reversal after several free-window payments nets correctly", () => {
  const summary = summarizeFreeWindowLedgerNet([
    { type: "FREE_WINDOW_PAYMENT", paymentId: "pay_1", amountPaise: 100000 },
    { type: "FREE_WINDOW_PAYMENT", paymentId: "pay_2", amountPaise: 80000 },
    { type: "FREE_WINDOW_PAYMENT", paymentId: "pay_3", amountPaise: 50000 },
    { type: "REVERSAL", reversalOf: "pay_2", amountPaise: 80000 },
  ]);
  assert.equal(summary.netTotalPaise, 150000);
  assert.equal(summary.netPositivePaymentCount, 2);
});

test("partial reversal uses remaining net amount", () => {
  const summary = summarizeFreeWindowLedgerNet([
    { type: "FREE_WINDOW_PAYMENT", paymentId: "pay_1", amountPaise: 100000 },
    { type: "REVERSAL", reversalOf: "pay_1", amountPaise: 40000 },
  ]);
  assert.equal(summary.netTotalPaise, 60000);
  assert.equal(summary.netPositivePaymentCount, 1);
});
