import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePhonePeOrderStatus,
  PhonePeOrderStatusKind,
  pickPhonePeTransactionId,
} from "../src/lib/phonepe-order-status.js";

test("normalizePhonePeOrderStatus maps completed provider state", () => {
  const normalized = normalizePhonePeOrderStatus({
    state: "COMPLETED",
    amount: 25_000,
    paymentDetails: [{ state: "COMPLETED", transactionId: "txn_1", amount: 25_000 }],
  });
  assert.equal(normalized.kind, PhonePeOrderStatusKind.COMPLETED);
  assert.equal(normalized.transactionId, "txn_1");
});

test("normalizePhonePeOrderStatus maps terminal failure", () => {
  const normalized = normalizePhonePeOrderStatus({
    state: "FAILED",
    amount: 10_000,
    paymentDetails: [],
  });
  assert.equal(normalized.kind, PhonePeOrderStatusKind.TERMINAL_FAILED);
});

test("pickPhonePeTransactionId prefers completed attempt", () => {
  assert.equal(
    pickPhonePeTransactionId([
      { state: "FAILED", transactionId: "a" },
      { state: "COMPLETED", transactionId: "b" },
    ]),
    "b",
  );
});
