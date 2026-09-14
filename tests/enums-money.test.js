import test from "node:test";
import assert from "node:assert/strict";
import { CycleStatus, PaymentStatus, enumValues } from "../src/constants/enums.js";
import { moneyRef, moneyToWeightMg, weightRef } from "../src/lib/money.js";

test("runtime enums are frozen and expose canonical values", () => {
  assert.equal(Object.isFrozen(PaymentStatus), true);
  assert.deepEqual(enumValues(CycleStatus), ["UPCOMING", "PARTIALLY_PAID", "PAID", "EXPIRED"]);
  assert.equal(PaymentStatus.PENDING, "PENDING");
  assert.throws(() => { PaymentStatus.NEW_VALUE = "NEW_VALUE"; }, TypeError);
});

test("paise and milligrams format without currency scale loss", () => {
  assert.equal(moneyRef(-500000).amountDisplay, "-₹5,000");
  assert.equal(weightRef(126480).weightDisplay, "126.480 g");
  assert.equal(moneyToWeightMg(84200000, 6657100), 12648);
  assert.throws(() => moneyRef(1.25), /safe integer/);
});

