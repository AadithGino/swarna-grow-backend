import test from "node:test";
import assert from "node:assert/strict";
import {
  clearAssistInterpretForTests,
  interpret,
  setAssistInterpretForTests,
} from "../src/integrations/llm/provider.js";

test.afterEach(() => {
  clearAssistInterpretForTests();
});

test("interpret retries once on invalid action then returns corrected action", async () => {
  let calls = 0;
  setAssistInterpretForTests(async (args) => {
    calls += 1;
    if (args.correction) {
      return { kind: "query", spec: { entity: "customers", filters: [] } };
    }
    return {
      kind: "query",
      spec: {
        entity: "customers",
        filters: [{ field: "notARealField", op: "eq", value: "x" }],
      },
    };
  });

  const action = await interpret({
    question: "customers",
    context: { todayIst: "2026-10-22" },
    toolCatalog: {},
  });
  assert.equal(action.kind, "query");
  assert.equal(action.spec.entity, "customers");
  assert.equal(calls, 2);
});

test("interpret returns clarify when validation fails twice", async () => {
  setAssistInterpretForTests(async () => ({
    kind: "query",
    spec: {
      entity: "customers",
      filters: [{ field: "notARealField", op: "eq", value: "x" }],
    },
  }));

  const action = await interpret({
    question: "customers",
    context: {},
    toolCatalog: {},
  });
  assert.equal(action.kind, "clarify");
  assert.match(action.question, /didn't quite catch/i);
});

test("interpret override self-corrects once on invalid report key", async () => {
  let calls = 0;
  setAssistInterpretForTests(async (args) => {
    calls += 1;
    if (args.correction) {
      return { kind: "clarify", question: "Fixed path" };
    }
    return { kind: "report", reportKey: "NOT_A_REPORT", filters: {} };
  });

  const action = await interpret({
    question: "x",
    context: {},
    toolCatalog: {},
  });
  assert.equal(action.kind, "clarify");
  assert.equal(action.question, "Fixed path");
  assert.equal(calls, 2);
});
