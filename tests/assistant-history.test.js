import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  AssistantConversation,
  AssistantMessage,
  AssistantRole,
} from "../src/models/assistant.models.js";
import {
  appendTurn,
  getOrCreateConversation,
  listMessages,
} from "../src/services/assistant/assistant-history.service.js";
import {
  clearAssistInterpretForTests,
  setAssistInterpretForTests,
  setAssistNarrateForTests,
} from "../src/integrations/llm/provider.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  clearAssistInterpretForTests();
  await stopTestDb();
});
test.beforeEach(async () => {
  clearAssistInterpretForTests();
  await resetTestDb();
});

function mockReq(user) {
  return {
    auth: { id: user._id, tenantId: user.tenantId, role: user.role },
    scope: { tenantId: user.tenantId },
  };
}

test("appendTurn bumps messageCount, lastMessageAt, and sets title on first turn", async () => {
  const { user } = await seedTenantUser({});
  const req = mockReq(user);
  const conv = await getOrCreateConversation(req, null);
  assert.equal(conv.messageCount, 0);
  assert.equal(conv.title, "New chat");

  await appendTurn(req, conv._id, "How much did we collect?", {
    summaryText: "Collection report",
    action: { kind: "report", reportKey: "COLLECTION" },
  });

  const updated = await AssistantConversation.findById(conv._id).lean();
  assert.equal(updated.messageCount, 2);
  assert.ok(updated.lastMessageAt);
  assert.equal(updated.title, "How much did we collect?");

  const count = await AssistantMessage.countDocuments({ conversationId: conv._id });
  assert.equal(count, 2);
});

test("listMessages paginates with cursor — no overlap, scoped to user", async () => {
  const { user } = await seedTenantUser({});
  const { user: otherUser } = await seedTenantUser({ mobile: "+919876543210" });
  const req = mockReq(user);
  const otherReq = mockReq(otherUser);
  const conv = await getOrCreateConversation(req, null);

  const base = Date.now();
  for (let i = 0; i < 30; i += 1) {
    await AssistantMessage.create({
      tenantId: user.tenantId,
      userId: user._id,
      conversationId: conv._id,
      role: i % 2 === 0 ? AssistantRole.USER : AssistantRole.ASSISTANT,
      text: i % 2 === 0 ? `user-${i}` : undefined,
      bundle: i % 2 === 1 ? { summaryText: `assistant-${i}` } : undefined,
      createdAt: new Date(base - i * 1000),
    });
  }

  const page1 = await listMessages(req, conv._id, { limit: 10 });
  assert.equal(page1.data.length, 10);
  assert.ok(page1.meta.hasMore);
  assert.ok(page1.meta.nextCursor);

  const page2 = await listMessages(req, conv._id, {
    limit: 10,
    cursor: page1.meta.nextCursor,
  });
  assert.equal(page2.data.length, 10);

  const ids1 = new Set(page1.data.map((r) => r._id));
  for (const row of page2.data) {
    assert.ok(!ids1.has(row._id), "pages must not overlap");
  }

  await assert.rejects(
    () => listMessages(otherReq, conv._id, { limit: 10 }),
    (err) => err?.code === "ASSISTANT_CONVERSATION_NOT_FOUND",
  );
});

test("1000 messages paginate in fixed page size without skip", async () => {
  const { user } = await seedTenantUser({});
  const req = mockReq(user);
  const conv = await getOrCreateConversation(req, null);
  const docs = [];
  const base = Date.now();
  for (let i = 0; i < 1000; i += 1) {
    docs.push({
      tenantId: user.tenantId,
      userId: user._id,
      conversationId: conv._id,
      role: AssistantRole.USER,
      text: `msg-${i}`,
      createdAt: new Date(base - i * 1000),
    });
  }
  await AssistantMessage.insertMany(docs, { ordered: false });

  const t0 = Date.now();
  let cursor;
  let pages = 0;
  let total = 0;
  do {
    const page = await listMessages(req, conv._id, { limit: 25, cursor });
    pages += 1;
    total += page.data.length;
    cursor = page.meta.nextCursor;
    if (!page.meta.hasMore) break;
  } while (cursor && pages < 50);
  const elapsed = Date.now() - t0;

  assert.equal(total, 1000);
  assert.equal(pages, 40);
  assert.ok(elapsed < 15_000, `pagination took too long: ${elapsed}ms`);
});

test("POST chat persists turn and returns conversationId", { timeout: 60_000 }, async () => {
  const { user } = await seedTenantUser({});
  setAssistNarrateForTests(async () => "Stub.");
  setAssistInterpretForTests(async () => ({
    kind: "clarify",
    question: "Which period?",
  }));

  const res = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "Hello sidekick" });

  assert.equal(res.status, 200);
  assert.ok(res.body.data.conversationId?.startsWith("acv_"));
  assert.ok(res.body.data.messageId?.startsWith("amg_"));

  const msgs = await AssistantMessage.find({
    conversationId: res.body.data.conversationId,
  }).lean();
  assert.equal(msgs.length, 2);
});
