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

test("only a documented pending state counts as recognized pending", async () => {
  const { isRecognizedPendingState } = await import("../src/lib/phonepe-order-status.js");
  assert.equal(isRecognizedPendingState("PENDING"), true);
  assert.equal(isRecognizedPendingState("pending"), true);
  for (const unknown of ["", undefined, null, "UNKNOWN", "SOMETHING_NEW"]) {
    assert.equal(isRecognizedPendingState(unknown), false, String(unknown));
  }
  // The shared normalizer still files unrecognized states under PENDING so other flows keep polling.
  const { normalizePhonePeOrderStatus } = await import("../src/lib/phonepe-order-status.js");
  assert.equal(normalizePhonePeOrderStatus({}).kind, "PENDING");
  assert.equal(normalizePhonePeOrderStatus({}).state, "UNKNOWN");
});
