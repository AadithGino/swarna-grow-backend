import test from "node:test";
import assert from "node:assert/strict";
import { PaymentStatus } from "../src/constants/enums.js";
import { paymentGoldAccrualDto } from "../src/lib/payment-gold-dto.js";
import { goldAccrualLiabilityPaise } from "../src/lib/gold-accrual-netting.js";

test("goldAccrual DTO uses net retained weight after partial refund", () => {
  const payment = {
    weightMg: 200,
    refundedWeightMg: 50,
    ratePerGramPaise: 500_000,
    paidAt: new Date("2026-09-01"),
  };
  const dto = paymentGoldAccrualDto(payment);
  assert.equal(dto.weightMg, 150);
  assert.equal(dto.grossGoldAccrual.weightMg, 200);
  assert.equal(dto.valuePaise, goldAccrualLiabilityPaise(150, 500_000));
});

test("fully reversed payment yields zero net goldAccrual with gross preserved", () => {
  const payment = {
    weightMg: 200,
    refundedWeightMg: 200,
    ratePerGramPaise: 500_000,
    status: PaymentStatus.REVERSED,
  };
  const dto = paymentGoldAccrualDto(payment);
  assert.equal(dto.weightMg, 0);
  assert.equal(dto.valuePaise, 0);
  assert.equal(dto.grossGoldAccrual.weightMg, 200);
});
