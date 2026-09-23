import test from "node:test";
import assert from "node:assert/strict";
import { LedgerEntryType, PaymentStatus } from "../src/constants/enums.js";
import {
  mapAdminLedgerEntry,
  paymentGoldAccrualDto,
  paymentGrossGoldAccrualDto,
  paymentReceiptExtraLines,
} from "../src/lib/payment-gold-dto.js";

const payment = {
  weightMg: 200,
  refundedWeightMg: 50,
  ratePerGramPaise: 500_000,
  paidAt: new Date("2026-09-01"),
  status: PaymentStatus.PARTIALLY_REFUNDED,
};

test("current payment goldAccrual DTO is net retained with gross sibling", () => {
  const dto = paymentGoldAccrualDto(payment);
  assert.equal(dto.weightMg, 150);
  assert.equal(dto.grossGoldAccrual.weightMg, 200);
});

test("receipt extra lines show original gross weight", () => {
  const lines = paymentReceiptExtraLines(payment);
  assert.ok(lines.some((line) => line.includes("Gold weight:")));
  assert.equal(paymentGrossGoldAccrualDto(payment).weightMg, 200);
});

test("ledger installment credit shows entry gross weight not payment net", () => {
  const entry = {
    _id: "led_1",
    type: LedgerEntryType.INSTALLMENT_PAYMENT,
    weightMg: 200,
    ratePerGramPaise: 500_000,
    amountPaise: 100_000,
    createdAt: new Date("2026-09-01"),
  };
  const row = mapAdminLedgerEntry(entry, payment);
  assert.equal(row.goldAccrual.weightMg, 200);
});

test("ledger reversal row shows its own weight", () => {
  const entry = {
    _id: "led_2",
    type: LedgerEntryType.REVERSAL,
    weightMg: 50,
    ratePerGramPaise: 500_000,
    amountPaise: -25_000,
    createdAt: new Date("2026-09-02"),
  };
  const row = mapAdminLedgerEntry(entry, payment);
  assert.equal(row.goldAccrual.weightMg, 50);
});

test("fully reversed payment DTO shows zero net and preserved gross", () => {
  const reversed = { ...payment, refundedWeightMg: 200, status: PaymentStatus.REVERSED };
  const dto = paymentGoldAccrualDto(reversed);
  assert.equal(dto.weightMg, 0);
  assert.equal(dto.grossGoldAccrual.weightMg, 200);
});
