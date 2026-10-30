import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import "../src/lib/date.js";
import { createApp } from "../src/app.js";
import { AssistantUsageDaily } from "../src/models/index.js";
import { clearGeminiAgentForTests, setGeminiAgentForTests } from "../src/integrations/llm/gemini-agent.js";
import { clearAssistInterpretForTests } from "../src/integrations/llm/provider.js";
import { GUIDE_IDS, matchGuideIntent } from "../src/services/assistant/agent/guides.js";
import { TOOL_DECLARATIONS } from "../src/services/assistant/agent/tools.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  clearGeminiAgentForTests();
  await stopTestDb();
});
test.beforeEach(async () => {
  clearGeminiAgentForTests();
  clearAssistInterpretForTests();
  await resetTestDb();
});

function call(name, args) {
  return { content: { role: "model", parts: [{ functionCall: { name, args } }] }, usage: { promptTokens: 4000, cachedTokens: 2000, outputTokens: 120 } };
}

test("guide matcher picks the right walkthrough for how-to wording", () => {
  const cases = {
    "how do I add a customer?": "add-customer",
    "how to add new customer": "add-customer",
    "customer kaise add kare": "add-customer",
    "I forgot how to add a product": "add-product",
    "add product": "add-product",
    "where do I set today's gold rate": "set-gold-rate",
    "how to enrol customer": "enrol-customer",
    "how do I record a payment": "record-payment",
    "how to create a new scheme": "create-scheme",
    "how do I add staff": "add-staff",
    "show me around": "welcome",
    "naya customer kaise banaye": "add-customer",
    "how do I accept a cod order": "cod-orders",
    "how to publish digi gold rate": "dm-rates",
    "how to reverse a payment": "reverse-payment",
    "how do I approve redemption": "approve-redemption",
    "how to close scheme early": "close-early",
    "how do I create a flexible scheme": "create-flexible-scheme",
    "how to reset staff password": "manage-staff",
  };
  for (const [message, id] of Object.entries(cases)) {
    assert.equal(matchGuideIntent(message)?.id, id, message);
  }
});

test("guide matcher leaves data questions and vague messages to the agent", () => {
  for (const message of [
    "how many customers did we add this month?",
    "how much did we collect today",
    "which customers were added last week",
    "customers",
    "what is the gold rate today",
    "hi",
    "how do I improve collections from overdue customers",
    "how do I improve collections",
  ]) {
    assert.equal(matchGuideIntent(message), null, message);
  }
});

test("start_walkthrough offers every guide id", () => {
  const decl = TOOL_DECLARATIONS.find((t) => t.name === "start_walkthrough");
  assert.ok(decl);
  assert.deepEqual(decl.parameters.properties.guideId.enum, [...GUIDE_IDS]);
});

test("how-to questions get a walkthrough instantly, without the model or the daily cap", { timeout: 60_000 }, async () => {
  const { tenant, user } = await seedTenantUser({});
  let modelCalls = 0;
  setGeminiAgentForTests(async () => {
    modelCalls += 1;
    return call("final_answer", { answer: "should not be used" });
  });
  const res = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "How do I add a customer?" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.guide, { id: "add-customer", title: "Add a new customer" });
  assert.match(res.body.data.narrative, /Create customer/);
  assert.equal(modelCalls, 0);
  const usage = await AssistantUsageDaily.findOne({ tenantId: tenant._id }).lean();
  assert.ok(!usage || !usage.questions);

  // The guide survives in chat history so the button is still there on reload.
  const conversationId = res.body.data.conversationId;
  const history = await request(app)
    .get(`/api/v1/admin/assistant/conversations/${conversationId}/messages`)
    .set("Authorization", `Bearer ${bearerFor(user)}`);
  assert.equal(history.status, 200, JSON.stringify(history.body));
  const items = history.body.data?.items ?? history.body.data;
  const answer = items.find((m) => m.role === "assistant");
  assert.equal(answer.bundle.guide.id, "add-customer");
});

test("the agent can attach a walkthrough with start_walkthrough", { timeout: 60_000 }, async () => {
  const { user } = await seedTenantUser({});
  let round = 0;
  setGeminiAgentForTests(async () => {
    round += 1;
    if (round === 1) return call("start_walkthrough", { guideId: "add-product", purpose: "Preparing the guide" });
    return call("final_answer", {
      title: "Add a product",
      answer: "ഇങ്ങനെ ചെയ്യാം:\n- Online store → Products\n- Add product",
    });
  });
  const res = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "പുതിയ പ്രോഡക്റ്റ് എങ്ങനെ ചേർക്കാം?" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.guide, { id: "add-product", title: "Add a product to your online store" });
  assert.equal(res.body.data.blocks.length, 0, "a guide is not a data block");
  assert.equal(res.body.data.steps[0].tool, "start_walkthrough");
});

test("an unknown guide id goes back to the model as a tool error", { timeout: 60_000 }, async () => {
  const { user } = await seedTenantUser({});
  const seen = [];
  setGeminiAgentForTests(async (req) => {
    seen.push(req);
    if (seen.length === 1) return call("start_walkthrough", { guideId: "launch-rocket" });
    return call("final_answer", { answer: "I don't have a guide for that yet." });
  });
  const res = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "teach me something odd please" });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.guide, undefined);
  const last = seen[1].contents.at(-1).parts.find((p) => p.functionResponse);
  assert.match(last.functionResponse.response.error.message, /Unknown guideId/);
});
