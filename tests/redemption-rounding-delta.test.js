import test from "node:test";
import assert from "node:assert/strict";
import {
  applyWeightPrecisionMg,
  decimalRoundingMode,
  moneyPaiseFromWeightMg,
  moneyToWeightMg,
} from "../src/lib/money.js";

test("cash gold handover rounding delta is settlement minus valued handover weight", () => {
  const settlementPaise = 50_000;
  const ratePerGramPaise = 6_000_00;
  const rounding = decimalRoundingMode("HALF_UP");
  const precisionMg = 1;
  let handoverWeightMg = moneyToWeightMg(settlementPaise, ratePerGramPaise, rounding);
  handoverWeightMg = applyWeightPrecisionMg(handoverWeightMg, precisionMg, rounding);
  const handoverValuePaise = moneyPaiseFromWeightMg(handoverWeightMg, ratePerGramPaise);
  const roundingDeltaPaise = settlementPaise - handoverValuePaise;
  assert.ok(handoverWeightMg > 0);
  assert.ok(Math.abs(roundingDeltaPaise) < settlementPaise);
});
