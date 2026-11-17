import assert from "node:assert/strict";
import test from "node:test";
import { previewSchemePurchase } from "../src/lib/ecommerce-scheme-purchase-preview.js";

const taxComponentLines = [{ componentKey: "GST", label: "GST", rateBps: 300 }];
function line(productId, purity = "22K") {
  return { productId, quantity: 1, lineTotalPaise: 780_000, pricingSnapshot: {
    estimate: { gold: { purity, weightMg: 10_000, goldValuePaise: 700_000 }, making: { afterOfferPaise: 50_000 } },
    componentTax: { totalPaise: 23_400 },
  } };
}
const quote = { lines: [line("a"), line("b")], fulfilmentChargePaise: 10_000, financialSnapshot: { taxComponentLines } };

test("cash value uses only eligible lines after waiving making charges and recalculating tax", () => {
  const result = previewSchemePurchase({ quote, eligibleProductIds: new Set(["a"]),
    rules: { makingChargeWaiver: { kind: "FULL" } }, basis: "CASH_VALUE", balance: 900_000 });
  assert.equal(result.makingChargeWaivedPaise, 50_000);
  assert.equal(result.appliedPaise, 751_900);
  assert.equal(result.remaining, 148_100);
  assert.equal(result.topUpPaise, 813_400);
  assert.equal(result.lines[1].schemeAppliedPaise, 0);
});

test("gold adjusts only the gold component and fixed waiver cap applies once per quote", () => {
  const result = previewSchemePurchase({ quote, eligibleProductIds: new Set(["a", "b"]),
    rules: { makingChargeWaiver: { kind: "FIXED", amountPaise: 80_000 }, waiverCapPaise: 60_000 },
    basis: "GOLD_WEIGHT", balance: 12_000 });
  assert.deepEqual(result.lines.map((row) => row.schemeAppliedWeightMg), [10_000, 2_000]);
  assert.deepEqual(result.lines.map((row) => row.makingChargeWaivedPaise), [50_000, 10_000]);
  assert.equal(result.appliedPaise, 840_000);
  assert.equal(result.topUpPaise, 715_000);
});

test("a gold weight preview rejects a cart without eligible same-purity products", () => {
  assert.throws(() => previewSchemePurchase({
    quote: { ...quote, lines: [line("a", "18K")] }, eligibleProductIds: new Set(["a"]),
    rules: {}, basis: "GOLD_WEIGHT", balance: 5_000,
  }), { code: "NO_SCHEME_AMOUNT_APPLICABLE" });
});

test("percentage honours use post-offer making charges and keep a partial cash balance exact", () => {
  const result = previewSchemePurchase({ quote, eligibleProductIds: new Set(["a", "b"]),
    rules: { makingChargeWaiver: { kind: "PERCENT", basisPoints: 3333 }, waiverCapPaise: 20_000 },
    basis: "CASH_VALUE", balance: 130_001 });
  assert.deepEqual(result.lines.map((row) => row.makingChargeWaivedPaise), [2696, 0]);
  assert.equal(result.applied, 130_001);
  assert.equal(result.remaining, 0);
  assert.equal(result.topUpPaise + result.appliedPaise, result.totalPaise);
});

test("a token scheme balance cannot waive charges on unfunded items", () => {
  const result = previewSchemePurchase({ quote, eligibleProductIds: new Set(["a", "b"]),
    rules: { makingChargeWaiver: { kind: "FULL" } }, basis: "CASH_VALUE", balance: 1 });
  assert.equal(result.lines[1].schemeAppliedPaise, 0);
  assert.equal(result.makingChargeWaivedPaise, 0);
});
