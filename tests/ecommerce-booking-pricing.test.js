import test from "node:test";
import assert from "node:assert/strict";
import { priceBookingInvoice, bookedRateFromRow } from "../src/lib/ecommerce-booking-pricing.js";

const NOW = new Date("2026-11-18T10:00:00Z");
const fresh = (ratePerGramPaise, extra = {}) => ({
  _id: `rate-${ratePerGramPaise}`, purity: "22K", ratePerGramPaise, version: 1, effectiveAt: new Date("2026-11-18T09:00:00Z"), ...extra,
});
const product = {
  _id: "prod1", name: "Ring", sku: "R-1", version: 3, status: "PUBLISHED", priceMode: "GOLD_RATE_BASED",
  purity: "22K", goldWeightMg: 10_000, makingChargeMode: "PERCENT_OF_GOLD", makingCharge: { percentBps: 1000 },
  taxClassification: "GST_3", hsnSacCode: "7113", hsnSacType: "HSN",
};
const context = {
  taxSettings: { version: 1, rates: [{ code: "GST_3", rateBps: 300, active: true }], defaultClassification: "GST_3", hsnSacMappings: [{ classification: "GST_3", hsnSacCode: "7113", hsnSacType: "HSN" }] },
  fulfilment: { version: 1 }, fulfilmentChargePaise: 0, destinationState: "Kerala", supplyCase: "INTRA_STATE", pickupBranchId: "br1",
  componentLines: [{ componentKey: "CGST", label: "CGST", rateBps: 150 }, { componentKey: "SGST", label: "SGST", rateBps: 150 }],
};
const common = { product, context, stockPolicy: "QUANTITY_TRACKED", at: NOW };
const protectedUntil = new Date("2026-11-19T10:00:00Z");
const booked = (rate = 700_000, over = {}) => ({ ...bookedRateFromRow(fresh(rate)), protectedUntil, ...over });

test("advance quote prices at the live rate and matches the checkout arithmetic", () => {
  const inv = priceBookingInvoice({ ...common, stage: "ADVANCE_QUOTE", liveRateRow: fresh(700_000) });
  // gold: 10 g * 7000.00 = 70,000.00; making 10% = 7,000.00; pre-tax 77,000.00; tax 3% = 2,310.00 (1.5% + 1.5%)
  assert.equal(inv.subtotalPaise, 77_000_00);
  assert.equal(inv.taxPaise, 2_310_00);
  assert.equal(inv.totalPaise, 79_310_00);
  assert.equal(inv.rateSource, "LIVE");
  assert.equal(inv.lines[0].quantity, 1);
  assert.equal(inv.lines[0].lineTotalPaise, inv.subtotalPaise);
  assert.equal(inv.financialSnapshot.totalPaise, inv.totalPaise);
  assert.equal(inv.financialSnapshot.supplyCase, "INTRA_STATE");
});

test("final billing, BOOKED_RATE: the booked rate while protected, even if gold rose", () => {
  const inv = priceBookingInvoice({ ...common, stage: "FINAL", rateRule: "BOOKED_RATE", bookedRate: booked(700_000), liveRateRow: fresh(800_000) });
  assert.equal(inv.rateSource, "BOOKED");
  assert.equal(inv.subtotalPaise, 77_000_00);
  assert.equal(inv.lines[0].pricingSnapshot.estimate.gold.rateSource, "SAVED");
});

test("final billing, BOOKED_RATE needs no live rate while protected, but needs a fresh one after", () => {
  const during = priceBookingInvoice({ ...common, stage: "FINAL", rateRule: "BOOKED_RATE", bookedRate: booked(), liveRateRow: null });
  assert.equal(during.rateSource, "BOOKED");
  const lapsed = booked(700_000, { protectedUntil: new Date("2026-11-18T09:00:00Z") });
  assert.throws(() => priceBookingInvoice({ ...common, stage: "FINAL", rateRule: "BOOKED_RATE", bookedRate: lapsed, liveRateRow: null }),
    (e) => e.code === "PRICE_NOT_COMPUTABLE" && e.details.blockers.some((b) => b.code === "GOLD_RATE_MISSING"));
  const stale = fresh(800_000, { effectiveAt: new Date("2025-01-01T00:00:00Z") });
  assert.throws(() => priceBookingInvoice({ ...common, stage: "FINAL", rateRule: "BOOKED_RATE", bookedRate: lapsed, liveRateRow: stale }),
    (e) => e.code === "PRICE_NOT_COMPUTABLE");
  const after = priceBookingInvoice({ ...common, stage: "FINAL", rateRule: "BOOKED_RATE", bookedRate: lapsed, liveRateRow: fresh(800_000) });
  assert.equal(after.rateSource, "BILLING_DAY");
  assert.equal(after.subtotalPaise, 88_000_00, "10 g * 8000 + 10% making");
});

test("final billing, BILLING_DAY: always the live rate", () => {
  const inv = priceBookingInvoice({ ...common, stage: "FINAL", rateRule: "BILLING_DAY", bookedRate: booked(700_000), liveRateRow: fresh(650_000) });
  assert.equal(inv.rateSource, "BILLING_DAY");
  assert.equal(inv.subtotalPaise, 71_500_00);
  assert.throws(() => priceBookingInvoice({ ...common, stage: "FINAL", rateRule: "BILLING_DAY", bookedRate: booked(), liveRateRow: null }),
    (e) => e.code === "PRICE_NOT_COMPUTABLE");
});

test("final billing, LOWER_OF: rising keeps the booked rate, falling takes the live rate, stale live blocks both", () => {
  const rule = "LOWER_OF_BOOKED_AND_BILLING_DAY";
  const rising = priceBookingInvoice({ ...common, stage: "FINAL", rateRule: rule, bookedRate: booked(700_000), liveRateRow: fresh(800_000) });
  assert.equal(rising.rateSource, "BOOKED");
  assert.equal(rising.subtotalPaise, 77_000_00);
  const falling = priceBookingInvoice({ ...common, stage: "FINAL", rateRule: rule, bookedRate: booked(700_000), liveRateRow: fresh(650_000) });
  assert.equal(falling.rateSource, "BILLING_DAY");
  assert.equal(falling.subtotalPaise, 71_500_00);
  const stale = fresh(800_000, { effectiveAt: new Date("2025-01-01T00:00:00Z") });
  assert.throws(() => priceBookingInvoice({ ...common, stage: "FINAL", rateRule: rule, bookedRate: booked(700_000), liveRateRow: stale }),
    (e) => e.code === "PRICE_NOT_COMPUTABLE", "the booked rate cannot stand in for a stale billing rate");
  assert.throws(() => priceBookingInvoice({ ...common, stage: "FINAL", rateRule: rule, bookedRate: booked(700_000), liveRateRow: null }),
    (e) => e.code === "PRICE_NOT_COMPUTABLE");
});

test("a fixed-price product has no gold rate to book or look up", () => {
  const fixed = { ...product, priceMode: "FIXED", fixedPricing: { basePricePaise: 50_000_00 }, goldWeightMg: undefined, purity: undefined };
  const inv = priceBookingInvoice({ ...common, product: fixed, stage: "FINAL", rateRule: "BILLING_DAY", bookedRate: null, liveRateRow: null });
  assert.equal(inv.rateSource, "FIXED");
  assert.equal(inv.subtotalPaise, 50_000_00);
  assert.equal(inv.totalPaise, 51_500_00);
});

test("a missing HSN/SAC mapping blocks the invoice", () => {
  const bad = { ...context, taxSettings: { ...context.taxSettings, hsnSacMappings: [] } };
  assert.throws(() => priceBookingInvoice({ ...common, context: bad, product: { ...product, hsnSacCode: undefined, hsnSacType: undefined }, stage: "ADVANCE_QUOTE", liveRateRow: fresh(700_000) }),
    (e) => e.code === "CHECKOUT_NOT_READY");
});
