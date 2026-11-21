import test from "node:test";
import assert from "node:assert/strict";
import {
  EcommerceMakingChargeMode,
  EcommerceOfferType,
  EcommercePriceMode,
} from "../src/constants/enums.js";
import {
  applyMakingChargeOffer,
  buildSavedRateOption,
  computeGoldValuePaise,
  computeMakingChargePaise,
  computeProductPriceEstimate,
  roundHalfUpPaise,
} from "../src/lib/ecommerce-pricing.js";

test("roundHalfUpPaise at half boundaries", () => {
  assert.equal(roundHalfUpPaise(10.4), 10);
  assert.equal(roundHalfUpPaise(10.5), 11);
});

test("gold value uses mg and paise per gram", () => {
  assert.equal(computeGoldValuePaise(5000, 600_000), 3_000_000);
});

test("gold value large integers without float drift", () => {
  assert.equal(
    computeGoldValuePaise(100_056_463, 90_030_973),
    9_008_180_718_828,
  );
});

test("making charge modes", () => {
  assert.equal(
    computeMakingChargePaise({
      mode: EcommerceMakingChargeMode.FIXED_PAISE,
      goldValuePaise: 1000,
      weightMg: 2000,
      makingCharge: { fixedPaise: 500 },
    }),
    500,
  );
  assert.equal(
    computeMakingChargePaise({
      mode: EcommerceMakingChargeMode.PER_GRAM_PAISE,
      goldValuePaise: 1000,
      weightMg: 2500,
      makingCharge: { perGramPaise: 400 },
    }),
    1000,
  );
  assert.equal(
    computeMakingChargePaise({
      mode: EcommerceMakingChargeMode.PERCENT_OF_GOLD,
      goldValuePaise: 10_000,
      weightMg: 1000,
      makingCharge: { percentBps: 500 },
    }),
    500,
  );
});

test("offer cannot exceed making charge", () => {
  assert.throws(
    () =>
      applyMakingChargeOffer(100, {
        type: EcommerceOfferType.FIXED_PAISE_OFF,
        valuePaise: 150,
      }),
    (err) => err.code === "ECOMMERCE_OFFER_EXCEEDS_MAKING",
  );
});

test("dynamic product estimate itemizes tax", () => {
  const estimate = computeProductPriceEstimate({
    product: {
      priceMode: EcommercePriceMode.GOLD_RATE_BASED,
      purity: "22K",
      goldWeightMg: 5000,
      makingChargeMode: EcommerceMakingChargeMode.FIXED_PAISE,
      makingCharge: { fixedPaise: 2000 },
      stones: [{ name: "Ruby", chargePaise: 1500 }],
      otherChargesPaise: 500,
      taxClassification: "GST_3",
      version: 2,
    },
    rateRow: {
      _id: "egrt_1",
      ratePerGramPaise: 600_000,
      version: 1,
      effectiveAt: new Date("2026-06-01T00:00:00Z"),
    },
    taxSettings: {
      version: 3,
      rates: [{ code: "GST_3", label: "GST 3%", rateBps: 300, active: true }],
    },
    atMs: new Date("2026-06-02T00:00:00Z").getTime(),
  });
  assert.equal(estimate.computable, true);
  assert.equal(estimate.gold.goldValuePaise, 3_000_000);
  assert.equal(estimate.preTaxSubtotalPaise, 3_004_000);
  assert.equal(estimate.tax.totalPaise, 90_120);
  assert.equal(estimate.displayTotalPaise, 3_094_120);
});

test("fixed product uses sale window", () => {
  const estimate = computeProductPriceEstimate({
    product: {
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: {
        basePricePaise: 50_000,
        salePricePaise: 45_000,
        saleStartsAt: "2026-01-01T00:00:00.000Z",
        saleEndsAt: "2027-01-01T00:00:00.000Z",
      },
      taxClassification: "GST_3",
    },
    taxSettings: {
      version: 1,
      rates: [{ code: "GST_3", rateBps: 300, active: true }],
    },
    atMs: new Date("2026-06-01T00:00:00Z").getTime(),
  });
  assert.equal(estimate.preTaxSubtotalPaise, 45_000);
});

test("stale gold rate blocks dynamic estimate", () => {
  const staleAt = new Date("2026-06-01T00:00:00Z").getTime();
  const estimate = computeProductPriceEstimate({
    product: {
      priceMode: EcommercePriceMode.GOLD_RATE_BASED,
      purity: "22K",
      goldWeightMg: 1000,
      makingChargeMode: EcommerceMakingChargeMode.FIXED_PAISE,
      makingCharge: { fixedPaise: 100 },
    },
    rateRow: {
      _id: "egrt_old",
      ratePerGramPaise: 600_000,
      effectiveAt: new Date(staleAt - 8 * 86_400_000),
    },
    taxSettings: { version: 1, rates: [] },
    atMs: staleAt,
  });
  assert.equal(estimate.computable, false);
  assert.ok(estimate.blockers.some((b) => b.code === "GOLD_RATE_STALE"));
  assert.equal(estimate.displayTotalPaise, null);
});

test("fixed price does not add making or stones", () => {
  const estimate = computeProductPriceEstimate({
    product: {
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 99_000 },
      makingChargeMode: EcommerceMakingChargeMode.FIXED_PAISE,
      makingCharge: { fixedPaise: 50_000 },
      stones: [{ chargePaise: 10_000 }],
      taxClassification: "GST_3",
    },
    taxSettings: {
      version: 1,
      rates: [{ code: "GST_3", rateBps: 300, active: true }],
    },
  });
  assert.equal(estimate.preTaxSubtotalPaise, 99_000);
  assert.equal(estimate.contract.fixedPriceAllInclusive, true);
});

test("missing rate blocks dynamic estimate", () => {
  const estimate = computeProductPriceEstimate({
    product: {
      priceMode: EcommercePriceMode.GOLD_RATE_BASED,
      purity: "18K",
      goldWeightMg: 1000,
      makingChargeMode: EcommerceMakingChargeMode.FIXED_PAISE,
      makingCharge: { fixedPaise: 100 },
    },
    rateRow: null,
    taxSettings: { version: 1, rates: [] },
  });
  assert.equal(estimate.computable, false);
  assert.ok(estimate.blockers.some((b) => b.code === "GOLD_RATE_MISSING"));
});

// ---------- saved-rate pricing (advance bookings) ----------

const DAY = 86_400_000;
const T0 = new Date("2026-06-01T00:00:00Z").getTime();
const goldProduct = {
  priceMode: EcommercePriceMode.GOLD_RATE_BASED,
  purity: "22K",
  goldWeightMg: 5000,
  makingChargeMode: EcommerceMakingChargeMode.FIXED_PAISE,
  makingCharge: { fixedPaise: 2000 },
  taxClassification: "GST_3",
};
const taxSettings = { version: 1, rates: [{ code: "GST_3", label: "GST 3%", rateBps: 300, active: true }] };
const savedOption = (overrides = {}) => buildSavedRateOption({
  ratePerGramPaise: 600_000, purity: "22K", rateId: "egrt_saved", rateVersion: 4,
  savedAt: new Date(T0), validUntil: new Date(T0 + 30 * DAY), at: new Date(T0), ...overrides,
});
const estimateAt = (atMs, extra = {}) => computeProductPriceEstimate({ product: goldProduct, taxSettings, atMs, ...extra });

test("saved rate prices an old booking even though the saved rate is far past the freshness window", () => {
  const atMs = T0 + 20 * DAY; // 20 days old: stale for a live rate, still inside the 30-day policy
  const live = estimateAt(atMs, { rateRow: { _id: "egrt_saved", ratePerGramPaise: 600_000, effectiveAt: new Date(T0) } });
  assert.equal(live.computable, false);
  assert.ok(live.blockers.some((b) => b.code === "GOLD_RATE_STALE"));

  const saved = estimateAt(atMs, { savedRate: savedOption() });
  assert.equal(saved.computable, true);
  assert.equal(saved.gold.goldValuePaise, 3_000_000);
  assert.equal(saved.gold.ratePerGramPaise, 600_000);
  assert.equal(saved.gold.rateSource, "SAVED");
  assert.equal(saved.gold.rateId, "egrt_saved");
  assert.equal(saved.rateFreshness.code, "SAVED_RATE");
  assert.equal(saved.preTaxSubtotalPaise, 3_002_000);
  assert.equal(saved.tax.totalPaise, 90_060);
});

test("the saved rate wins over a live rate row: a booking never reprices to today's rate", () => {
  const estimate = estimateAt(T0 + DAY, {
    savedRate: savedOption(),
    rateRow: { _id: "egrt_today", ratePerGramPaise: 900_000, effectiveAt: new Date(T0 + DAY) },
  });
  assert.equal(estimate.gold.ratePerGramPaise, 600_000);
  assert.equal(estimate.gold.goldValuePaise, 3_000_000);
});

test("once the policy has ended the estimate is blocked and does not fall back to a live rate", () => {
  const option = savedOption();
  const after = estimateAt(T0 + 31 * DAY, {
    savedRate: option,
    rateRow: { _id: "egrt_today", ratePerGramPaise: 900_000, effectiveAt: new Date(T0 + 31 * DAY) },
  });
  assert.equal(after.computable, false);
  assert.ok(after.blockers.some((b) => b.code === "SAVED_RATE_EXPIRED"));
  assert.equal(after.displayTotalPaise, null);
  assert.equal(after.gold.goldValuePaise, 0);
  // The boundary instant itself is already expired.
  assert.ok(estimateAt(T0 + 30 * DAY, { savedRate: option }).blockers.some((b) => b.code === "SAVED_RATE_EXPIRED"));
  assert.equal(estimateAt(T0 + 30 * DAY - 1, { savedRate: option }).computable, true);
});

test("a saved rate cannot be built for an already-ended or malformed policy", () => {
  assert.throws(() => savedOption({ validUntil: new Date(T0 - 1) }), { code: "SAVED_RATE_EXPIRED" });
  assert.throws(() => savedOption({ validUntil: undefined }), { code: "SAVED_RATE_INVALID" });
  assert.throws(() => savedOption({ ratePerGramPaise: 0 }), { code: "SAVED_RATE_INVALID" });
  assert.throws(() => savedOption({ ratePerGramPaise: 600_000.5 }), { code: "SAVED_RATE_INVALID" });
  assert.throws(() => savedOption({ purity: "" }), { code: "SAVED_RATE_INVALID" });
});

test("a saved rate is only valid for the purity it was saved for", () => {
  const estimate = estimateAt(T0 + DAY, { savedRate: savedOption({ purity: "18K" }) });
  assert.equal(estimate.computable, false);
  assert.ok(estimate.blockers.some((b) => b.code === "SAVED_RATE_PURITY_MISMATCH"));
});

test("an object that merely looks like a saved rate is ignored: only the server-built option counts", () => {
  const forged = { ratePerGramPaise: 1, purity: "22K", validUntilMs: T0 + 365 * DAY, saved: true };
  const stale = { _id: "egrt_old", ratePerGramPaise: 600_000, effectiveAt: new Date(T0 - 8 * DAY) };
  const viaForgery = estimateAt(T0, { savedRate: forged, rateRow: stale });
  assert.equal(viaForgery.computable, false);
  assert.ok(viaForgery.blockers.some((b) => b.code === "GOLD_RATE_STALE"), "the live freshness check still runs");
  // A body parsed from JSON cannot carry the brand either.
  const fromJson = JSON.parse(JSON.stringify(savedOption()));
  const viaJson = estimateAt(T0, { savedRate: fromJson, rateRow: stale });
  assert.ok(viaJson.blockers.some((b) => b.code === "GOLD_RATE_STALE"));
  assert.equal(viaJson.gold.rateSource, undefined);
});

test("live inputs still go through their checks when a saved rate is used", () => {
  const noTax = computeProductPriceEstimate({
    product: goldProduct, taxSettings: { version: 1, rates: [] }, atMs: T0 + DAY, savedRate: savedOption(),
  });
  assert.equal(noTax.computable, false);
  assert.ok(noTax.blockers.some((b) => b.code === "TAX_CLASSIFICATION_UNKNOWN"));
  const noWeight = computeProductPriceEstimate({
    product: { ...goldProduct, goldWeightMg: 0 }, taxSettings, atMs: T0 + DAY, savedRate: savedOption(),
  });
  assert.ok(noWeight.blockers.some((b) => b.code === "WEIGHT_INVALID"));
});

test("a saved rate does not change fixed-price products or the shape of ordinary estimates", () => {
  const fixed = { priceMode: EcommercePriceMode.FIXED, basePricePaise: 100_000, taxClassification: "GST_3" };
  const withSaved = computeProductPriceEstimate({ product: fixed, taxSettings, atMs: T0, savedRate: savedOption() });
  const without = computeProductPriceEstimate({ product: fixed, taxSettings, atMs: T0 });
  assert.deepEqual(withSaved, without);
  const ordinary = estimateAt(T0 + DAY, { rateRow: { _id: "egrt_1", ratePerGramPaise: 600_000, effectiveAt: new Date(T0) } });
  assert.equal("rateSource" in ordinary.gold, false);
  assert.equal("savedRateValidUntil" in ordinary.gold, false);
});
