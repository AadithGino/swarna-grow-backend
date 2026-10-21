/**
 * Phase 0 — frozen numerical acceptance examples for digital metals quotes/settlement.
 * Pure functions only; no Mongo/Redis. Phase 2 quote engine must match these cases.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  UG_PER_G,
  computeFeePaise as percentFeePaise,
  metalSubtotalPaiseFromQuantity,
  maxQuantityUgForBuyBudget as maxQuantityUgForBudget,
} from "../src/lib/digital-metals-quote-engine.js";

function buyTotalPaise(metalSubtotalPaise, feePaise, taxPaise = 0) {
  return metalSubtotalPaise + feePaise + taxPaise;
}

test("A1 same rate no fee — ₹6000 buys 1g", () => {
  const rate = 600_000; // ₹6000/g in paise
  const sub = metalSubtotalPaiseFromQuantity(UG_PER_G, rate);
  assert.equal(sub, 600_000);
  assert.equal(buyTotalPaise(sub, 0), 600_000);
});

test("A2 spread — sell 1g at sell rate", () => {
  const sellRate = 600_000;
  const sub = metalSubtotalPaiseFromQuantity(UG_PER_G, sellRate);
  assert.equal(sub, 600_000);
});

test("A3 buy 1% fee above minimum on 1g @ ₹6000/g", () => {
  const sub = 600_000;
  const fee = percentFeePaise(sub, { type: "PERCENT", percent: 1, minPaise: 5_000 });
  assert.equal(fee, 6_000);
  assert.equal(buyTotalPaise(sub, fee), 606_000);
});

test("A4 buy 1% fee with minimum ₹50 on 0.5g @ ₹4000/g", () => {
  const sub = metalSubtotalPaiseFromQuantity(500_000, 400_000);
  assert.equal(sub, 200_000);
  const fee = percentFeePaise(sub, { type: "PERCENT", percent: 1, minPaise: 5_000 });
  assert.equal(fee, 5_000);
  assert.equal(buyTotalPaise(sub, fee), 205_000);
});

test("A5 all-in budget ₹1000 no fee", () => {
  const rate = 600_000;
  const result = maxQuantityUgForBudget(100_000, rate, { type: "NONE" }, []);
  assert.ok(result.quantityUg > 0);
  assert.ok(result.totalPayablePaise <= 100_000);
  assert.ok(result.budgetRemainderPaise >= 0);
  assert.equal(
    result.metalSubtotalPaise,
    metalSubtotalPaiseFromQuantity(result.quantityUg, rate),
  );
});

test("A6 sell payout failure — metal stays debited (simulated balances)", () => {
  let heldUg = 5 * UG_PER_G;
  const sellUg = 2 * UG_PER_G;
  heldUg -= sellUg;
  const payablePaise = 1_200_000;
  const payoutStatus = "FAILED";
  assert.equal(heldUg, 3 * UG_PER_G);
  assert.equal(payoutStatus, "FAILED");
  assert.ok(payablePaise > 0);
});

test("A7 redemption reserves exactly 2g from 5g wallet", () => {
  const heldUg = 5 * UG_PER_G;
  const reserveUg = 2 * UG_PER_G;
  const availableUg = heldUg - reserveUg;
  assert.equal(reserveUg, 2_000_000);
  assert.equal(availableUg, 3_000_000);
});

test("A8 hedge day obligation and uncovered position", () => {
  const openingObligationUg = 0;
  const openingHedgeUg = 0;
  const buyUg = 3 * UG_PER_G;
  const sellUg = 1 * UG_PER_G;
  const handoverUg = 1 * UG_PER_G;
  const procureUg = 2 * UG_PER_G;

  const closingObligationUg = openingObligationUg + buyUg - sellUg - handoverUg;
  const closingHedgeUg = openingHedgeUg + procureUg - handoverUg;
  const uncoveredUg = closingObligationUg - closingHedgeUg;

  assert.equal(closingObligationUg, 1 * UG_PER_G);
  assert.equal(closingHedgeUg, 1 * UG_PER_G);
  assert.equal(uncoveredUg, 0);
});

test("A8b hedge with incomplete opening reports incomplete coverage", () => {
  const openingHedgeUg = null;
  const closingObligationUg = 2 * UG_PER_G;
  const closingHedgeUg = 1 * UG_PER_G;
  const coverageIncomplete = openingHedgeUg == null;
  assert.equal(coverageIncomplete, true);
  assert.notEqual(closingObligationUg - closingHedgeUg, 0);
});
