import test from "node:test";
import assert from "node:assert/strict";
import {
  EcommerceMakingChargeMode,
  EcommerceOfferType,
  EcommercePriceMode,
} from "../src/constants/enums.js";
import {
  applyMakingChargeOffer,
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
