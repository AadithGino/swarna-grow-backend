import test from "node:test";
import assert from "node:assert/strict";
import { rebuildSchemeProjection } from "../src/services/scheme.service.js";

test("flexible rebuild marks below-cap refunded cycle as PARTIALLY_PAID", () => {
  const scheme = {
    paymentPattern: "FLEXIBLE",
    cycles: [
      {
        cycle: "2026-01",
        capPaise: 100_000,
        paidPaise: 100_000,
        remainingPaise: 0,
        status: "PAID",
        expiresAt: "2026-12-31",
      },
    ],
    positionVersion: 1,
  };
  rebuildSchemeProjection(scheme, [
    { type: "INSTALLMENT_PAYMENT", cycle: "2026-01", amountPaise: 100_000 },
    { type: "REVERSAL", cycle: "2026-01", amountPaise: 40_000 },
  ]);
  assert.equal(scheme.cycles[0].paidPaise, 60_000);
  assert.equal(scheme.cycles[0].status, "PARTIALLY_PAID");
});
