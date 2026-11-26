import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampPayableQuoteToPhonePe, phonePeCheckoutMaxPaise } from "../src/lib/phonepe-checkout-limits.js";

describe("phonepe-checkout-limits", () => {
  it("sandbox default cap is 500000 paise", () => {
    assert.equal(phonePeCheckoutMaxPaise("SANDBOX"), 500_000);
  });

  it("clamps flexible free window max payable", () => {
    const quote = {
      model: "FLEXIBLE",
      phase: "FLEXIBLE",
      maxPayablePaise: 2_500_000,
      minPayablePaise: 10_000,
      payable: true,
    };
    const clamped = clampPayableQuoteToPhonePe(quote, "SANDBOX");
    assert.equal(clamped.maxPayablePaise, 500_000);
    assert.equal(clamped.gatewayCheckoutMaxPaise, 500_000);
  });
});