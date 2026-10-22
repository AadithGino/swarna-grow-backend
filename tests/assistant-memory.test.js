import test from "node:test";
import assert from "node:assert/strict";
import "../src/lib/date.js";
import request from "supertest";
import { createApp } from "../src/app.js";
import { resolveDatePreset } from "../src/lib/query-filters.js";
import {
  resetCalendarDateOverrideForTests,
  setCalendarDateOverrideForTests,
} from "../src/lib/date.js";
import {
  assistantCacheKey,
} from "../src/services/assistant/assistant.service.js";
import { resolveActionWithHistory } from "../src/services/assistant/follow-up.js";
import {
  clearAssistInterpretForTests,
  setAssistInterpretForTests,
  setAssistNarrateForTests,
} from "../src/integrations/llm/provider.js";
import { bearerFor, resetTestDb, seedTenantUser } from "./helpers/db.js";

const app = createApp();

test.beforeEach(async () => {
  clearAssistInterpretForTests();
  await resetTestDb();
});
test.after(() => {
  clearAssistInterpretForTests();
});

test("THIS_YEAR and LAST_365_DAYS presets resolve from calendar today", () => {
  setCalendarDateOverrideForTests("2026-10-15");
  try {
    const year = resolveDatePreset("THIS_YEAR");
    assert.equal(year.from, "2026-01-01");
    assert.equal(year.to, "2026-10-15");

    const last365 = resolveDatePreset("LAST_365_DAYS");
    assert.equal(last365.to, "2026-10-15");
    assert.ok(last365.from);
    assert.ok(last365.from < last365.to);
  } finally {
    resetCalendarDateOverrideForTests();
  }
});

test("assistantCacheKey differs when prior assistant action differs", () => {
  const req = {
    auth: { tenantId: "tenant_a", role: "TENANT_OWNER" },
    scope: { tenantId: "tenant_a" },
  };
  const question = "in last 365 days?";
  const keyEnrol = assistantCacheKey(req, question, [
    { role: "assistant", action: { kind: "report", reportKey: "ENROLMENT", filters: {} } },
  ]);
  const keyCollection = assistantCacheKey(req, question, [
    { role: "assistant", action: { kind: "report", reportKey: "COLLECTION", filters: {} } },
  ]);
  assert.notEqual(keyEnrol, keyCollection);
});

test("follow-up uses history to return ENROLMENT LAST_365_DAYS not clarify", { timeout: 60_000 }, async () => {
  const { user } = await seedTenantUser({});
  setAssistNarrateForTests(async () => "Stub narrative.");

  setAssistInterpretForTests(async ({ question, history }) => {
    const prev = [...(history ?? [])].reverse().find((h) => h.role === "assistant");
    if (/365/.test(question) && prev?.action?.reportKey === "ENROLMENT") {
      return {
        kind: "report",
        reportKey: "ENROLMENT",
        filters: { period: "LAST_365_DAYS" },
      };
    }
    if (/enrolment/i.test(question)) {
      return { kind: "report", reportKey: "ENROLMENT", filters: { period: "THIS_MONTH" } };
    }
    return { kind: "clarify", question: "Which report?" };
  });

  const first = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "How many active enrolments?" });

  assert.equal(first.status, 200);
  assert.equal(first.body.data.action?.reportKey, "ENROLMENT");

  const followUp = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({
      message: "in last 365 days?",
      conversationId: first.body.data.conversationId,
    });

  assert.equal(followUp.status, 200);
  assert.equal(followUp.body.data.action?.kind, "report");
  assert.equal(followUp.body.data.action?.reportKey, "ENROLMENT");
  assert.equal(followUp.body.data.action?.filters?.period, "LAST_365_DAYS");
});

test("resolveActionWithHistory applies 60-day window to prior branch report when LLM clarifies", () => {
  const prev = {
    kind: "report",
    reportKey: "BRANCH_PERFORMANCE",
    filters: { period: "LAST_30_DAYS", from: "2026-09-22", to: "2026-10-22" },
  };
  const clarify = { kind: "clarify", question: "Which report for last 60 days?" };
  const resolved = resolveActionWithHistory(
    "in last 60 days?",
    [{ role: "assistant", action: prev }],
    clarify,
    "2026-10-22",
  );
  assert.equal(resolved.kind, "report");
  assert.equal(resolved.reportKey, "BRANCH_PERFORMANCE");
  assert.equal(resolved.filters.from, "2026-08-24");
  assert.equal(resolved.filters.to, "2026-10-22");
  assert.equal(resolved.filters.period, undefined);
});

test("follow-up reuses COLLECTION from summary when history omits action", () => {
  const clarify = { kind: "clarify", question: "Which report for last 2 days?" };
  const resolved = resolveActionWithHistory(
    "in last 2 days ?",
    [
      { role: "user", text: "How much did we collect in the last 30 days?" },
      {
        role: "assistant",
        summary: "Collection report · 2026-09-22 – 2026-10-22",
      },
    ],
    clarify,
    "2026-10-22",
  );
  assert.equal(resolved.kind, "report");
  assert.equal(resolved.reportKey, "COLLECTION");
  assert.equal(resolved.filters.from, "2026-10-21");
  assert.equal(resolved.filters.to, "2026-10-22");
});
