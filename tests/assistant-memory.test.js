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
  cachePayloadFromResponse,
} from "../src/services/assistant/assistant.service.js";
import { resolveActionWithHistory } from "../src/services/assistant/follow-up.js";
import {
  actionForConversationFocus,
  applyConversationFocusToAction,
  deriveConversationFocusFromTurn,
  focusFingerprint,
} from "../src/services/assistant/conversation-focus.js";
import { AssistantConversation, AssistantMessage } from "../src/models/assistant.models.js";
import {
  clearAssistInterpretForTests,
  setAssistInterpretForTests,
  setAssistNarrateForTests,
} from "../src/integrations/llm/provider.js";
import { PaymentStatus } from "../src/constants/enums.js";
import { Customer, Payment } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { connectRedis, redisReady } from "../src/config/redis.js";
import { bearerFor, resetTestDb, seedTenantUser } from "./helpers/db.js";

const app = createApp();

test.before(async () => {
  await connectRedis();
});
test.beforeEach(async () => {
  clearAssistInterpretForTests();
  await resetTestDb();
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

test("assistantCacheKey differs when conversationFocus customer differs", () => {
  const req = {
    auth: { tenantId: "tenant_a", role: "TENANT_OWNER" },
    scope: { tenantId: "tenant_a" },
  };
  const question = "how much did he pay?";
  const keyA = assistantCacheKey(req, question, [], {
    customerId: "customer_a",
    customerName: "Alice",
  });
  const keyB = assistantCacheKey(req, question, [], {
    customerId: "customer_b",
    customerName: "Bob",
  });
  assert.notEqual(keyA, keyB);
  assert.ok(focusFingerprint({ customerId: "customer_a" }).includes("customer_a"));
});

test("assistantCacheKey differs when refined action differs", () => {
  const req = {
    auth: { tenantId: "tenant_a", role: "TENANT_OWNER" },
    scope: { tenantId: "tenant_a" },
  };
  const question = "collections";
  const lastPayment = assistantCacheKey(req, question, [], null, {
    kind: "query",
    spec: { entity: "collections", limit: 1, sort: "desc" },
  });
  const grouped = assistantCacheKey(req, question, [], null, {
    kind: "query",
    spec: {
      entity: "collections",
      groupBy: "customerId",
      aggregate: { fn: "sum", field: "amountPaise" },
      topN: 5,
    },
  });
  assert.notEqual(lastPayment, grouped);
});

test("assistantCacheKey differs when resolved report action differs", () => {
  const req = {
    auth: { tenantId: "tenant_a", role: "TENANT_OWNER" },
    scope: { tenantId: "tenant_a" },
  };
  const question = "in last 365 days?";
  const keyEnrol = assistantCacheKey(req, question, [], null, {
    kind: "report",
    reportKey: "ENROLMENT",
    filters: { period: "LAST_365_DAYS" },
  });
  const keyCollection = assistantCacheKey(req, question, [], null, {
    kind: "report",
    reportKey: "COLLECTION",
    filters: { period: "LAST_365_DAYS" },
  });
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

test("conversation focus routes scheme and payment follow-ups to focused customer", () => {
  const focus = { customerId: "cust_smoke", customerName: "Phase9 Smoke Customer" };
  const schemeAction = actionForConversationFocus(focus, "Is he part of any scheme?");
  assert.equal(schemeAction?.kind, "query");
  assert.equal(schemeAction?.spec?.entity, "schemes");
  assert.equal(schemeAction?.spec?.filters?.[0]?.value, "cust_smoke");

  const payAction = actionForConversationFocus(focus, "How much did he pay?");
  assert.equal(payAction?.spec?.entity, "collections");
  assert.equal(payAction?.spec?.filters?.some((f) => f.field === "customerId"), true);
  assert.equal(payAction?.spec?.aggregate?.fn, "sum");

  const globalLatest = applyConversationFocusToAction(
    {
      kind: "query",
      spec: {
        entity: "collections",
        filters: [{ field: "status", op: "eq", value: "SUCCESS" }],
        sort: "desc",
        limit: 1,
      },
    },
    focus,
    "How much did he pay?",
  );
  assert.equal(globalLatest.spec.filters.some((f) => f.field === "customerId"), true);
  assert.equal(globalLatest.spec.limit, undefined);
});

test("deriveConversationFocusFromTurn captures customer from customers query row", () => {
  const focus = deriveConversationFocusFromTurn({
    action: {
      kind: "query",
      spec: { entity: "customers", sort: "desc", limit: 1 },
    },
    bundle: {
      table: {
        rows: [{ id: "cust_newest", name: "Phase9 Smoke Customer", mobile: "9000000001" }],
      },
    },
  });
  assert.equal(focus?.customerId, "cust_newest");
  assert.equal(focus?.customerName, "Phase9 Smoke Customer");
});

test("cachePayloadFromResponse strips per-turn ids", () => {
  const payload = cachePayloadFromResponse({
    messageId: "amg_old",
    conversationId: "acv_1",
    cached: false,
    summaryText: "Hi",
  });
  assert.equal(payload.messageId, undefined);
  assert.equal(payload.conversationId, undefined);
  assert.equal(payload.summaryText, "Hi");
});

test("cache hit appends a new assistant message id", { timeout: 60_000 }, async () => {
  if (!redisReady()) return;
  const { user } = await seedTenantUser({});
  setAssistNarrateForTests(async () => "Stub.");
  setAssistInterpretForTests(async () => ({
    kind: "report",
    reportKey: "ENROLMENT",
    filters: { period: "THIS_MONTH" },
  }));

  const question = "Active enrolments this month";
  const first = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: question });
  assert.equal(first.status, 200);
  const convId = first.body.data.conversationId;

  const second = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: question, conversationId: convId });
  assert.equal(second.status, 200);
  assert.equal(second.body.data.cached, true);
  assert.notEqual(second.body.data.messageId, first.body.data.messageId);

  const count = await AssistantMessage.countDocuments({ conversationId: convId });
  assert.equal(count, 4);
});

test("customer pronoun follow-up stays on focused customer not global latest payment", {
  timeout: 60_000,
}, async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const smokeId = createId("customer");
  const otherId = createId("customer");
  await Customer.create([
    {
      _id: smokeId,
      tenantId: tenant._id,
      branchId: branch._id,
      name: "Phase9 Smoke Customer",
      mobile: "9111111111",
      customerNumber: "C-SMOKE",
      status: "ACTIVE",
      createdAt: new Date("2026-10-20T10:00:00Z"),
    },
    {
      _id: otherId,
      tenantId: tenant._id,
      branchId: branch._id,
      name: "Aadith",
      mobile: "9222222222",
      customerNumber: "C-AADITH",
      status: "ACTIVE",
      createdAt: new Date("2026-09-01T10:00:00Z"),
    },
  ]);
  await Payment.create([
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: smokeId,
      schemeId: createId("scheme"),
      receiptNumber: "RCP-SMOKE-1",
      amountPaise: 50_000,
      status: PaymentStatus.SUCCESS,
      mode: "CASH",
      paidAt: new Date("2026-10-10T10:00:00Z"),
      collectedBy: user._id,
      source: "STAFF_APP",
    },
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: otherId,
      schemeId: createId("scheme"),
      receiptNumber: "RCP-AADITH-NEW",
      amountPaise: 99_000,
      status: PaymentStatus.SUCCESS,
      mode: "UPI",
      paidAt: new Date("2026-10-24T10:00:00Z"),
      collectedBy: user._id,
      source: "STAFF_APP",
    },
  ]);

  setAssistNarrateForTests(async () => "Stub narrative.");
  setAssistInterpretForTests(async ({ question }) => {
    if (/last created an account/i.test(question)) {
      return {
        kind: "query",
        spec: { entity: "customers", sort: "desc", limit: 1 },
      };
    }
    if (/part of any scheme/i.test(question)) {
      return {
        kind: "query",
        spec: {
          entity: "collections",
          filters: [{ field: "status", op: "eq", value: "SUCCESS" }],
          sort: "desc",
          limit: 1,
        },
      };
    }
    if (/how much did he pay/i.test(question)) {
      return {
        kind: "query",
        spec: {
          entity: "collections",
          filters: [{ field: "status", op: "eq", value: "SUCCESS" }],
          sort: "desc",
          limit: 1,
        },
      };
    }
    return { kind: "clarify", question: "?" };
  });

  const first = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "Which customer last created an account?" });
  assert.equal(first.status, 200);
  assert.match(first.body.data.table?.rows?.[0]?.name ?? "", /Phase9 Smoke Customer/i);

  const convId = first.body.data.conversationId;
  const conv = await AssistantConversation.findById(convId).lean();
  assert.equal(conv?.conversationFocus?.customerId, smokeId);

  const second = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "Is he part of any scheme?", conversationId: convId });
  assert.equal(second.status, 200);
  assert.equal(second.body.data.action?.spec?.entity, "schemes");
  assert.equal(
    second.body.data.action?.spec?.filters?.find((f) => f.field === "customerId")?.value,
    smokeId,
  );

  const third = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "How much did he pay?", conversationId: convId });
  assert.equal(third.status, 200);
  assert.equal(third.body.data.action?.spec?.entity, "collections");
  const custFilter = third.body.data.action?.spec?.filters?.find((f) => f.field === "customerId");
  assert.equal(custFilter?.value, smokeId);
  assert.equal(third.body.data.action?.spec?.limit, undefined);
  assert.notEqual(third.body.data.summaryText, "Latest payment · RCP-AADITH-NEW");
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
