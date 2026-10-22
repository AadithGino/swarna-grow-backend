import test from "node:test";
import assert from "node:assert/strict";
import { validateAssistantAction } from "../src/validators/assistant.validators.js";
import {
  bundleFromComposite,
  factsFromComposite,
} from "../src/services/assistant/response-bundle.js";

test("validateAssistantAction accepts composite with known reports", () => {
  const action = validateAssistantAction({
    kind: "composite",
    reports: [
      { reportKey: "MATURITY_REDEMPTION", filters: { period: "THIS_MONTH" } },
      { reportKey: "GOLD_ACCRUAL", filters: { period: "THIS_MONTH" } },
    ],
  });
  assert.equal(action.kind, "composite");
  assert.equal(action.reports.length, 2);
});

test("bundleFromComposite is text-only (no stat cards or chart)", () => {
  const parts = [
    {
      summaryText: "Maturity & redemption · Oct 2026",
      statCards: [{ label: "Matured", value: 5, valueType: "count" }],
      chart: { type: "bar", series: [] },
      table: null,
    },
    {
      summaryText: "Gold accrual & liability · Oct 2026",
      statCards: [{ label: "Liability", value: 100, valueType: "weight" }],
      chart: null,
      table: null,
    },
  ];
  const bundle = bundleFromComposite(parts, {
    kind: "composite",
    reports: [
      { reportKey: "MATURITY_REDEMPTION" },
      { reportKey: "GOLD_ACCRUAL" },
    ],
  });
  assert.equal(bundle.vizHint, "composite-text");
  assert.equal(bundle.statCards.length, 0);
  assert.equal(bundle.chart, null);
  assert.equal(bundle.table, null);
  assert.match(bundle.summaryText, /Overview/i);

  const facts = factsFromComposite(parts);
  assert.equal(facts.composite, true);
  assert.equal(facts.sections.length, 2);
});
