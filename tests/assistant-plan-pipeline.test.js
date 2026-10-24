import test from "node:test";
import assert from "node:assert/strict";
import { resolveInclusiveRollingDays } from "../src/services/assistant/assistant-date-window.js";
import {
  isCollectionDailyBreakdownQuestion,
  isLatestSingleReceiptIntent,
  validateAndNormalizeAssistantPlan,
} from "../src/services/assistant/assistant-plan.js";
import { isLastPaymentDetailQuestion, refineQueryAction } from "../src/services/assistant/refine-query.js";

test("resolveInclusiveRollingDays last 30 days inclusive on 2026-10-24", () => {
  const window = resolveInclusiveRollingDays(30, "2026-10-24");
  assert.equal(window.from, "2026-09-25");
  assert.equal(window.to, "2026-10-24");
});

test("isLastPaymentDetailQuestion rejects collection last 30 days phrasing", () => {
  assert.equal(
    isLastPaymentDetailQuestion("How much did we collect in the last 30 days?"),
    false,
  );
  assert.equal(
    isLastPaymentDetailQuestion("can u give me daily break down of collection of last 30 days"),
    false,
  );
});

test("validateAndNormalize preserves daily plan instead of latest payment override", () => {
  const modelDaily = {
    kind: "query",
    spec: {
      entity: "collections",
      filters: [{ field: "status", op: "eq", value: "SUCCESS" }],
      from: "2026-09-25",
      to: "2026-10-24",
      timeBucket: "day",
      aggregate: { fn: "sum", field: "amountPaise" },
      sort: "desc",
    },
  };
  const action = validateAndNormalizeAssistantPlan(
    "can u give me daily break down of collection of last 30 days",
    modelDaily,
    { todayIst: "2026-10-24" },
  );
  assert.equal(action.kind, "collectionDaily");
  assert.equal(action.filters.from, "2026-09-25");
  assert.equal(action.filters.to, "2026-10-24");
});

test("reproduction Q1 fixes LAST_3_MONTHS to explicit 30-day window", () => {
  const action = validateAndNormalizeAssistantPlan(
    "How much did we collect in the last 30 days?",
    { kind: "report", reportKey: "COLLECTION", filters: { period: "LAST_3_MONTHS" } },
    { todayIst: "2026-10-24" },
  );
  assert.equal(action.kind, "report");
  assert.equal(action.filters.from, "2026-09-25");
  assert.equal(action.filters.to, "2026-10-24");
  assert.equal(action.filters.period, undefined);
});

test("latest payment in last 30 days stays latest-with-window not daily series", () => {
  assert.equal(isLatestSingleReceiptIntent("What was the latest payment in the last 30 days?"), true);
  assert.equal(isCollectionDailyBreakdownQuestion("daily collection last 30 days"), true);
  const action = refineQueryAction(
    "What was the latest payment in the last 30 days?",
    {
      kind: "query",
      spec: {
        entity: "collections",
        filters: [{ field: "status", op: "eq", value: "SUCCESS" }],
        sort: "desc",
        limit: 1,
      },
    },
    { todayIst: "2026-10-24" },
  );
  assert.equal(action.spec.limit, 1);
  assert.equal(action.spec.from, "2026-09-25");
  assert.equal(action.spec.to, "2026-10-24");
});
