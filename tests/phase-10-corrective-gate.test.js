import test from "node:test";
import assert from "node:assert/strict";
import { subscriptionInvoiceTaxBreakdown } from "../src/services/subscription-invoice-pdf.service.js";

test("subscription invoice PDF tax uses persisted subtotal and tax paise", () => {
  const breakdown = subscriptionInvoiceTaxBreakdown({
    amountPaise: 11_800,
    subtotalPaise: 10_000,
    taxPaise: 1_800,
    taxPercent: 18,
  });
  assert.deepEqual(breakdown, { taxable: 10_000, gst: 1_800, total: 11_800 });
});

test("subscription invoice PDF legacy inclusive total splits GST with half-up paise", () => {
  const breakdown = subscriptionInvoiceTaxBreakdown({
    amountPaise: 11_800,
    taxPercent: 18,
  });
  assert.equal(breakdown.gst, 1_800);
  assert.equal(breakdown.taxable, 10_000);
  assert.equal(breakdown.total, 11_800);
});
