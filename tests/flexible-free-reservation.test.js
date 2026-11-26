import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { quoteAfterPendingIntentReservation } from "../src/services/payment.service.js";

describe("flexible free window payment reservation", () => {
  it("does not subtract pending intent sums from per-payment max", () => {
    const quote = {
      model: "FLEXIBLE",
      phase: "FLEXIBLE",
      maxPayablePaise: 2_500_000,
      payable: true,
    };
    const adjusted = quoteAfterPendingIntentReservation(quote, 2_500_000);
    assert.equal(adjusted.maxPayablePaise, 2_500_000);
    assert.equal(adjusted.reservedPaise, 2_500_000);
  });

  it("subtracts pending amounts for capped phase", () => {
    const quote = {
      model: "FLEXIBLE",
      phase: "CAPPED",
      maxPayablePaise: 500_000,
      remainingPaise: 500_000,
      payable: true,
    };
    const adjusted = quoteAfterPendingIntentReservation(quote, 200_000);
    assert.equal(adjusted.maxPayablePaise, 300_000);
    assert.equal(adjusted.remainingPaise, 300_000);
  });
});