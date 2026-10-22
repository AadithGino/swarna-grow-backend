import test from "node:test";
import assert from "node:assert/strict";
import {
  isBestMonthCollectionQuestion,
  isLastPaymentDetailQuestion,
  refineQueryAction,
} from "../src/services/assistant/refine-query.js";
import { normalizeAssistantQuestion } from "../src/services/assistant/normalize-question.js";

test("normalizeAssistantQuestion fixes common typos", () => {
  assert.equal(
    normalizeAssistantQuestion("which month best colaction last two onth"),
    "which month best collection last two month",
  );
});

test("isBestMonthCollectionQuestion detects month comparison intent", () => {
  assert.equal(
    isBestMonthCollectionQuestion("which month best collection last two month"),
    true,
  );
  assert.equal(
    isBestMonthCollectionQuestion("which month best colaction last two onth"),
    true,
  );
});

test("refineQueryAction maps collection report to monthly query for best month", () => {
  const action = refineQueryAction(
    "which month best colaction last two onth not branch",
    { kind: "report", reportKey: "COLLECTION", filters: { period: "LAST_3_MONTHS" } },
    { todayIst: "2026-10-22" },
  );
  assert.equal(action.kind, "query");
  assert.equal(action.spec.timeBucket, "month");
  assert.equal(action.spec.topN, 2);
  assert.equal(action.spec.from, "2026-09-01");
  assert.equal(action.spec.to, "2026-10-22");
  assert.equal(action.spec.groupBy, undefined);
});

test("refineQueryAction overrides collection report on first typo question (no not branch)", () => {
  const action = refineQueryAction(
    "which month best colaction last two onth",
    { kind: "report", reportKey: "COLLECTION", filters: {} },
    { todayIst: "2026-10-22" },
  );
  assert.equal(action.kind, "query");
  assert.equal(action.spec.timeBucket, "month");
  assert.equal(action.spec.topN, 2);
});

test("refineQueryAction merges not branch follow-up with prior user question", () => {
  const history = [
    { role: "user", text: "which month best colaction last two onth" },
    { role: "assistant", summary: "Collection report · …" },
  ];
  const action = refineQueryAction(
    "not branch",
    { kind: "report", reportKey: "COLLECTION", filters: {} },
    { todayIst: "2026-10-22", history },
  );
  assert.equal(action.kind, "query");
  assert.equal(action.spec.timeBucket, "month");
  assert.equal(action.spec.topN, 2);
});

test("isLastPaymentDetailQuestion detects last payment phrasing", () => {
  assert.equal(
    isLastPaymentDetailQuestion(
      "which was the last scheme payment who did that which payment count",
    ),
    true,
  );
  assert.equal(isLastPaymentDetailQuestion("collection by branch this month"), false);
});

test("refineQueryAction replaces grouped query with latest payment list", () => {
  const action = refineQueryAction("last payment details", {
    kind: "query",
    spec: {
      entity: "collections",
      groupBy: "schemeId",
      aggregate: { fn: "sum", field: "amountPaise" },
      sort: "desc",
      topN: 1,
    },
  });
  assert.equal(action.kind, "query");
  assert.equal(action.spec.entity, "collections");
  assert.equal(action.spec.limit, 1);
  assert.equal(action.spec.sort, "desc");
  assert.equal(action.spec.groupBy, undefined);
  assert.equal(action.spec.filters?.[0]?.value, "SUCCESS");
});
