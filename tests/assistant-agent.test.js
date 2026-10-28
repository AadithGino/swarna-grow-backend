import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import "../src/lib/date.js";
import { createApp } from "../src/app.js";
import { PaymentStatus } from "../src/constants/enums.js";
import { AssistantUsageDaily, Customer, EcommerceOrder, Payment, Scheme, SchemePlan } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import {
  clearGeminiAgentForTests,
  setGeminiAgentForTests,
} from "../src/integrations/llm/gemini-agent.js";
import { clearAssistInterpretForTests } from "../src/integrations/llm/provider.js";
import { compileDataQuery, debugPipeline, previousWindow, runDataQuery } from "../src/services/assistant/agent/query-data.js";
import { checkAnswerNumbers, collectNumbers } from "../src/services/assistant/agent/number-guard.js";
import { AGENT_SYSTEM_PROMPT } from "../src/services/assistant/agent/agent.service.js";
import {
  bearerFor,
  resetTestDb,
  seedBranch,
  seedCustomer,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";

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

/* ------------------------------------------------------------------ helpers */

function call(name, args) {
  return { content: { role: "model", parts: [{ functionCall: { name, args } }] }, usage: { promptTokens: 4000, cachedTokens: 2000, outputTokens: 120 } };
}

/** Last function responses the model received (by tool name). */
function lastResponses(req) {
  const last = req.contents[req.contents.length - 1];
  return (last?.parts ?? []).filter((p) => p.functionResponse).map((p) => p.functionResponse);
}

/** Scripted fake Gemini: each step is (request) => response. */
function scripted(steps) {
  const seen = [];
  let i = 0;
  setGeminiAgentForTests(async (req) => {
    seen.push(req);
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return step(req);
  });
  return seen;
}

let receiptSeq = 0;
async function pay({ tenant, branch, customer, scheme, amount, mode, paidAt, user, status = PaymentStatus.SUCCESS }) {
  receiptSeq += 1;
  return Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    schemeId: scheme?._id ?? createId("scheme"),
    receiptNumber: `RCP-AG-${receiptSeq}`,
    amountPaise: amount * 100,
    status,
    mode,
    paidAt,
    collectedBy: user?._id,
    source: "STAFF_APP",
  });
}

async function plan(tenant, name = "Gold 360") {
  return SchemePlan.create({
    _id: createId("plan"),
    tenantId: tenant._id,
    name,
    code: name.replace(/\W+/g, "").toUpperCase().slice(0, 10),
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    durationMonths: 12,
    installmentCount: 12,
    status: "ACTIVE",
  });
}

async function scheme({ tenant, branch, customer, planDoc, overdue = 0, paid = 1 }) {
  const installments = [];
  for (let n = 1; n <= 12; n += 1) {
    installments.push({
      number: n,
      dueDate: `2026-${String(Math.min(n, 12)).padStart(2, "0")}-05`,
      amountPaise: 100_000,
      paidPaise: n <= paid ? 100_000 : 0,
      status: n <= paid ? "PAID" : n <= paid + overdue ? "OVERDUE" : "PENDING",
    });
  }
  return Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: planDoc._id,
    enrollmentNumber: `ENR-${Math.floor(Math.random() * 1e6)}`,
    planSnapshot: { name: planDoc.name },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-05",
    maturityDate: "2026-12-05",
    installmentAmountPaise: 100_000,
    installments,
  });
}

/* --------------------------------------------------------- compiler / safety */

test("query_data compiler injects tenant scope into the base match and every $lookup", () => {
  const scope = { tenantId: "tnt_A" };
  const pipeline = debugPipeline(
    {
      entity: "payments",
      filters: [{ field: "mode", op: "eq", value: "upi" }],
      groupBy: ["customer"],
      metrics: [{ fn: "sum", field: "amount" }],
    },
    scope,
  );
  const json = JSON.stringify(pipeline);
  assert.ok(pipeline[0].$match.$and[0].tenantId === "tnt_A");
  assert.match(json, /"mode":"UPI"/, "enum values are normalised");
  const lookups = [];
  JSON.parse(json, (k, v) => {
    if (k === "$lookup") lookups.push(v);
    return v;
  });
  assert.ok(lookups.length >= 1);
  for (const l of lookups) {
    assert.equal(l.pipeline[0].$match.tenantId, "tnt_A", "joined collection is tenant-filtered");
  }
});

test("query_data rejects unknown fields with a hint the model can use", () => {
  assert.throws(
    () => compileDataQuery({ entity: "customers", filters: [{ field: "kyc.numberMasked", op: "eq", value: "x" }] }, { tenantId: "t" }),
    (err) => err.name === "QuerySpecError" && /Unknown field/.test(err.message) && /Valid fields/.test(err.hint),
  );
  assert.throws(
    () => compileDataQuery({ entity: "payments", filters: [{ field: "mode", op: "eq", value: "BITCOIN" }] }, { tenantId: "t" }),
    (err) => /Allowed values/.test(err.hint),
  );
});

test("store orders are not available to branch-scoped users", () => {
  assert.throws(
    () => compileDataQuery({ entity: "store_orders" }, { tenantId: "t", branchId: "brn_1" }),
    (err) => err.code === "ASSISTANT_SCOPE",
  );
});

test("previous comparable window: month-to-date compares with the same days last month", () => {
  assert.deepEqual(previousWindow("2026-10-01", "2026-10-24"), { from: "2026-09-01", to: "2026-09-24" });
  assert.deepEqual(previousWindow("2026-10-01", "2026-10-31"), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(previousWindow("2026-10-18", "2026-10-24"), { from: "2026-10-11", to: "2026-10-17" });
});

test("number guard accepts figures from results and simple derived figures, rejects invented ones", () => {
  const allowed = collectNumbers({ rows: [{ amount: "₹1,02,650" }, { amount: "₹76,550" }], count: 47 });
  assert.equal(checkAnswerNumbers("You collected **₹1,02,650** from 47 payments.", allowed).ok, true);
  assert.equal(checkAnswerNumbers("That is ₹26,100 more than before.", allowed).ok, true, "difference of two results");
  assert.equal(checkAnswerNumbers("About ₹1.03 lakh in total.", allowed).ok, true, "rounded lakh form");
  const bad = checkAnswerNumbers("You collected ₹99,999 today.", allowed);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unknown, ["₹99,999"]);
});

test("system prompt stays a static, cacheable prefix", () => {
  assert.ok(!/2026-\d\d-\d\d/.test(AGENT_SYSTEM_PROMPT), "no dates in the static prompt");
  assert.ok(AGENT_SYSTEM_PROMPT.includes("### payments"));
});

/* ------------------------------------------------------------ end-to-end chat */

test("agent answers 'when was my last UPI payment' with the UPI receipt, not the latest cash one", { timeout: 60_000 }, async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const cust = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, name: "Ramesh Kumar", mobile: "+919812345678" });
  await pay({ tenant, branch, customer: cust, amount: 100, mode: "UPI", paidAt: new Date("2026-09-30T10:00:00+05:30"), user });
  await pay({ tenant, branch, customer: cust, amount: 5000, mode: "CASH", paidAt: new Date("2026-10-24T11:00:00+05:30"), user });

  const seen = scripted([
    () =>
      call("query_data", {
        entity: "payments",
        filters: [{ field: "mode", op: "eq", value: "UPI" }],
        sort: { by: "paidAt", dir: "desc" },
        limit: 1,
        purpose: "Finding your latest UPI payment",
      }),
    (req) => {
      const r = lastResponses(req)[0].response;
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].mode, "UPI");
      assert.equal(r.rows[0].amount, "₹100");
      assert.match(r.rows[0]["customer.name"], /Ramesh/);
      return call("final_answer", {
        title: "Last UPI payment",
        answer: `Your last UPI payment was on **${r.rows[0].paidAt}** — ${r.rows[0].amount} from ${r.rows[0]["customer.name"]}.`,
        blocks: [{ type: "table", resultId: r.resultId }],
        followUps: ["UPI payments this month", "Compare cash and UPI"],
      });
    },
  ]);

  const res = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "when was the last time i had a upi payment" });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  const b = res.body.data;
  assert.equal(b.engine, "agent");
  assert.match(b.narrative, /₹100/);
  assert.equal(b.blocks.length, 1);
  assert.equal(b.blocks[0].type, "table");
  assert.equal(b.blocks[0].table.rows.length, 1);
  assert.equal(b.blocks[0].table.rows[0].amount.value, 10_000);
  assert.equal(b.steps[0].label, "Finding your latest UPI payment");
  assert.equal(b.steps[0].status, "done");
  assert.deepEqual(b.followUps, ["UPI payments this month", "Compare cash and UPI"]);
  assert.equal(b.action.kind, "dataQuery");
  assert.equal(b.memory, undefined, "internal memory is not sent to the client");
  // context carries ready date windows; customer mobile is masked for the model
  const firstUserText = seen[0].contents.find((c) => c.role === "user" && c.parts[0]?.text?.includes("<context>")).parts[0].text;
  assert.match(firstUserText, /"last30Days"/);
  const toolPayload = JSON.stringify(lastResponses(seen[1]));
  assert.ok(!toolPayload.includes("9812345678"), "full mobile never reaches the model");
});

test("aggregate answers: top payers with names, stats + chart blocks, usage recorded", { timeout: 60_000 }, async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const a = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, name: "Anitha", mobile: "+919800000001" });
  const b = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, name: "Biju", mobile: "+919800000002" });
  const d = new Date();
  await pay({ tenant, branch, customer: a, amount: 3000, mode: "CASH", paidAt: d, user });
  await pay({ tenant, branch, customer: a, amount: 2000, mode: "UPI", paidAt: d, user });
  await pay({ tenant, branch, customer: b, amount: 1000, mode: "CASH", paidAt: d, user });
  await pay({ tenant, branch, customer: b, amount: 9000, mode: "CASH", paidAt: d, user, status: PaymentStatus.FAILED });

  scripted([
    () =>
      call("query_data", {
        entity: "payments",
        groupBy: ["customer"],
        metrics: [{ fn: "sum", field: "amount" }, { fn: "count" }],
        sort: { by: "sum_amount", dir: "desc" },
        limit: 5,
        purpose: "Ranking customers by amount paid",
      }),
    (req) => {
      const r = lastResponses(req)[0].response;
      assert.deepEqual(r.rows.map((x) => x.customer), ["Anitha", "Biju"]);
      assert.equal(r.rows[0].sum_amount, "₹5,000");
      assert.equal(r.totals.sum_amount, "₹6,000", "failed payment excluded by default");
      return call("final_answer", {
        title: "Top payers",
        answer: "Anitha paid the most: **₹5,000** across 2 payments.",
        blocks: [
          { type: "stats", resultId: r.resultId },
          { type: "chart", resultId: r.resultId, chartType: "bar" },
        ],
      });
    },
  ]);

  const res = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "sabse zyada paisa kisne diya?" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const bundle = res.body.data;
  assert.equal(bundle.blocks[0].type, "stats");
  assert.equal(bundle.blocks[0].cards[0].value, 600_000);
  assert.equal(bundle.blocks[1].type, "chart");
  assert.equal(bundle.blocks[1].chart.series[0].data[0].x, "Anitha");
  assert.equal(bundle.blocks[1].chart.series[0].data[0].y, 500_000);
  const usage = await AssistantUsageDaily.findOne({ tenantId: tenant._id }).lean();
  assert.equal(usage.questions, 1);
  assert.equal(usage.llmCalls, 2);
  assert.ok(usage.costMicroUsd > 0);
});

test("number guard makes the model rewrite an invented figure", { timeout: 60_000 }, async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const c = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await pay({ tenant, branch, customer: c, amount: 1500, mode: "CASH", paidAt: new Date(), user });
  let resultId;
  const seen = scripted([
    () => call("query_data", { entity: "payments", metrics: [{ fn: "sum", field: "amount" }], purpose: "Adding up payments" }),
    (req) => {
      resultId = lastResponses(req)[0].response.resultId;
      return call("final_answer", { answer: "You collected ₹42,000 so far." });
    },
    (req) => {
      const err = lastResponses(req)[0].response.error;
      assert.match(err, /₹42,000/);
      return call("final_answer", { answer: "You collected **₹1,500** so far.", blocks: [{ type: "stats", resultId }] });
    },
  ]);
  const res = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "total collection?" });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.narrative, "You collected **₹1,500** so far.");
  assert.equal(seen.length, 3);
});

test("schemes: overdue filter, computed fields and related names", { timeout: 60_000 }, async () => {
  const { tenant, branch } = await seedTenantUser({});
  const p = await plan(tenant, "Gold 360");
  const late = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, name: "Late Lakshmi", mobile: "+919800000011" });
  const fine = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, name: "Ontime Omana", mobile: "+919800000012" });
  await scheme({ tenant, branch, customer: late, planDoc: p, overdue: 3, paid: 2 });
  await scheme({ tenant, branch, customer: fine, planDoc: p, overdue: 0, paid: 5 });
  const result = await runDataQuery(
    {
      entity: "schemes",
      filters: [{ field: "overdueInstallments", op: "gte", value: "2" }],
      select: ["customer.name", "planName", "overdueInstallments", "overdueAmount"],
      sort: { by: "overdueInstallments", dir: "desc" },
    },
    { tenantId: tenant._id },
  );
  assert.equal(result.totalMatching, 1);
  assert.equal(result.modelRows[0]["customer.name"], "Late Lakshmi");
  assert.equal(result.modelRows[0].overdueInstallments, "3");
  assert.equal(result.modelRows[0].overdueAmount, "₹3,000");
  assert.ok(result.modelRows[0].customerId, "relation id kept for follow-ups");
});

test("branch-scoped users only ever see their branch", { timeout: 60_000 }, async () => {
  const { tenant, branch } = await seedTenantUser({});
  const other = await seedBranch({ tenantId: tenant._id });
  const c1 = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile: "+919800000021" });
  const c2 = await seedCustomer({ tenantId: tenant._id, branchId: other._id, mobile: "+919800000022" });
  await pay({ tenant, branch, customer: c1, amount: 100, mode: "CASH", paidAt: new Date() });
  await pay({ tenant, branch: other, customer: c2, amount: 700, mode: "CASH", paidAt: new Date() });
  const own = await runDataQuery({ entity: "payments", metrics: [{ fn: "sum", field: "amount" }] }, { tenantId: tenant._id, branchId: other._id });
  assert.equal(own.totals[0].display, "₹700");
  const all = await runDataQuery({ entity: "payments", metrics: [{ fn: "sum", field: "amount" }] }, { tenantId: tenant._id });
  assert.equal(all.totals[0].display, "₹800");
  const otherTenant = await seedTenantUser({ mobile: "+919777766655" });
  const none = await runDataQuery({ entity: "payments", metrics: [{ fn: "sum", field: "amount" }] }, { tenantId: otherTenant.tenant._id });
  assert.equal(none.totals[0].value, 0);
});

test("follow-up turns see the previous answer and the data it used", { timeout: 60_000 }, async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const c = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, name: "Meera", mobile: "+919800000031" });
  await pay({ tenant, branch, customer: c, amount: 250, mode: "UPI", paidAt: new Date(), user });
  const seen = scripted([
    () => call("query_data", { entity: "payments", filters: [{ field: "mode", op: "eq", value: "UPI" }], limit: 1, sort: { by: "paidAt", dir: "desc" }, purpose: "Latest UPI" }),
    (req) => call("final_answer", { answer: `Last UPI was ${lastResponses(req)[0].response.rows[0].amount} from Meera.` }),
    (req) => {
      const texts = req.contents.flatMap((c) => c.parts.map((p) => p.text ?? "")).join("\n");
      assert.match(texts, /Last UPI was ₹250 from Meera/);
      assert.match(texts, /data used: query_data/);
      assert.match(texts, /customerId/);
      return call("final_answer", { answer: "Meera has no other payments." });
    },
  ]);
  const first = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "last upi payment" });
  assert.equal(first.status, 200);
  const second = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "did she pay anything else?", conversationId: first.body.data.conversationId });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(seen.length, 3);
});

test("general questions are answered without touching data", { timeout: 60_000 }, async () => {
  const { user } = await seedTenantUser({});
  scripted([() => call("final_answer", { answer: "22 karat gold is about 91.6% pure gold.", followUps: ["What is hallmarking?"] })]);
  const res = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "what is 22k gold?" });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.blocks.length, 0);
  assert.equal(res.body.data.steps.length, 0);
  assert.match(res.body.data.narrative, /91\.6%/);
});

test("tool errors go back to the model, which can correct itself", { timeout: 60_000 }, async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const c = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await pay({ tenant, branch, customer: c, amount: 400, mode: "CARD", paidAt: new Date(), user });
  scripted([
    () => call("query_data", { entity: "payments", filters: [{ field: "paymentType", op: "eq", value: "card" }], purpose: "Card payments" }),
    (req) => {
      const r = lastResponses(req)[0].response;
      assert.match(r.error.message, /Unknown field/);
      return call("query_data", { entity: "payments", filters: [{ field: "mode", op: "eq", value: "card" }], purpose: "Card payments" });
    },
    (req) => call("final_answer", { answer: `Card payments: ${lastResponses(req)[0].response.rows[0].amount}.`, blocks: [{ type: "table", resultId: lastResponses(req)[0].response.resultId }] }),
  ]);
  const res = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "card payments?" });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.steps[0].status, "error");
  assert.equal(res.body.data.steps[1].status, "done");
  assert.match(res.body.data.narrative, /₹400/);
});

test("customer tools: find then overview", { timeout: 60_000 }, async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const p = await plan(tenant, "Swarna 11");
  const c = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, name: "Ramesh Kumar", mobile: "+919845012345" });
  const s = await scheme({ tenant, branch, customer: c, planDoc: p, overdue: 1, paid: 3 });
  await pay({ tenant, branch, customer: c, scheme: s, amount: 1000, mode: "UPI", paidAt: new Date(), user });
  scripted([
    () => call("find_customer", { query: "ramesh", purpose: "Looking up Ramesh" }),
    (req) => {
      const r = lastResponses(req)[0].response;
      assert.equal(r.matches, 1);
      assert.ok(!JSON.stringify(r).includes("9845012345"));
      return call("customer_overview", { customerId: r.customers[0].customerId, purpose: "Ramesh's schemes" });
    },
    (req) => {
      const r = lastResponses(req)[0].response;
      assert.equal(r.enrolments[0].plan, "Swarna 11");
      assert.equal(r.enrolments[0].overdueInstalments, 1);
      assert.equal(r.totals.totalPaid, "₹1,000");
      return call("final_answer", { answer: "Ramesh is in Swarna 11 with 1 overdue instalment; he has paid ₹1,000.", blocks: [{ type: "stats", resultId: r.resultId }, { type: "table", resultId: r.resultId }] });
    },
  ]);
  const res = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "ramesh ka scheme status?" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const blocks = res.body.data.blocks;
  assert.equal(blocks[0].type, "stats");
  assert.ok(blocks.filter((b) => b.type === "table").length >= 1);
});

test("streaming endpoint emits live steps then the final bundle", { timeout: 60_000 }, async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const c = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await pay({ tenant, branch, customer: c, amount: 300, mode: "CASH", paidAt: new Date(), user });
  scripted([
    () => call("query_data", { entity: "payments", metrics: [{ fn: "sum", field: "amount" }], purpose: "Adding up today's payments" }),
    (req) => call("final_answer", { answer: "Total is ₹300.", blocks: [{ type: "stats", resultId: lastResponses(req)[0].response.resultId }] }),
  ]);
  const res = await request(app)
    .post("/api/v1/admin/assistant/chat/stream")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .set("Accept", "text/event-stream")
    .buffer(true)
    .parse((r, cb) => {
      let data = "";
      r.on("data", (chunk) => {
        data += chunk.toString();
      });
      r.on("end", () => cb(null, data));
    })
    .send({ message: "today total" });
  assert.equal(res.status, 200);
  const text = res.body;
  assert.match(text, /event: step\ndata: .*Adding up today's payments/);
  const finalChunk = text.split("event: final\ndata: ")[1];
  assert.ok(finalChunk, text);
  const bundle = JSON.parse(finalChunk.split("\n\n")[0]);
  assert.equal(bundle.narrative, "Total is ₹300.");
  assert.ok(bundle.conversationId);
});

test("export re-runs an agent query with the same filters", { timeout: 60_000 }, async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const c = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, name: "Export Elsa", mobile: "+919800000041" });
  await pay({ tenant, branch, customer: c, amount: 120, mode: "UPI", paidAt: new Date(), user });
  await pay({ tenant, branch, customer: c, amount: 999, mode: "CASH", paidAt: new Date(), user });
  const res = await request(app)
    .post("/api/v1/admin/assistant/export")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({
      action: { kind: "dataQuery", spec: { entity: "payments", filters: [{ field: "mode", op: "eq", value: "UPI" }] } },
      fields: ["receiptNumber", "customer.name", "amount", "mode"],
      format: "CSV",
    });
  assert.equal(res.status, 200, res.text);
  const lines = res.text.trim().split("\n");
  assert.equal(lines[0], "Receipt,Customer,Amount,Mode");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /Export Elsa,₹120,UPI/);
});

test("daily question cap returns a friendly 429", { timeout: 60_000 }, async () => {
  const { tenant, user } = await seedTenantUser({});
  const { today } = await import("../src/lib/date.js");
  void user;
  await AssistantUsageDaily.create({ tenantId: tenant._id, day: today(), questions: 100_000 });
  scripted([() => call("final_answer", { answer: "hi" })]);
  const res = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "hello" });
  assert.equal(res.status, 429);
  assert.equal(res.body.error.code, "ASSISTANT_DAILY_LIMIT");
});

test("store order items: best-selling products from sold orders only", { timeout: 60_000 }, async () => {
  const { tenant, branch } = await seedTenantUser({});
  const c = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile: "+919800000051" });
  const mk = (status, lines) =>
    EcommerceOrder.collection.insertOne({
      _id: createId("order"),
      tenantId: tenant._id,
      customerId: c._id,
      orderNumber: `ORD-${Math.random()}`,
      status,
      lines,
      totalPaise: lines.reduce((a, l) => a + l.lineTotalPaise, 0),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  await mk("DELIVERED", [{ name: "Ring", quantity: 2, lineTotalPaise: 2_000_000 }, { name: "Chain", quantity: 1, lineTotalPaise: 3_000_000 }]);
  await mk("PAID", [{ name: "Ring", quantity: 1, lineTotalPaise: 1_000_000 }]);
  await mk("PAYMENT_FAILED", [{ name: "Chain", quantity: 9, lineTotalPaise: 9_000_000 }]);
  const r = await runDataQuery(
    { entity: "store_order_items", groupBy: ["productName"], metrics: [{ fn: "sum", field: "quantity" }, { fn: "sum", field: "lineTotal" }], sort: { by: "sum_quantity", dir: "desc" } },
    { tenantId: tenant._id },
  );
  assert.deepEqual(r.modelRows.map((x) => [x.productName, x.sum_quantity]), [["Ring", "3"], ["Chain", "1"]]);
  void Customer;
});

test("report + trend tools: COLLECTION report, Cash-vs-UPI trend, single-mode trend delegates to query_data", { timeout: 60_000 }, async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const c = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile: "+919800000061" });
  const { today } = await import("../src/lib/date.js");
  const day = today();
  await pay({ tenant, branch, customer: c, amount: 700, mode: "CASH", paidAt: new Date(`${day}T10:00:00+05:30`), user });
  await pay({ tenant, branch, customer: c, amount: 300, mode: "UPI", paidAt: new Date(`${day}T11:00:00+05:30`), user });
  const { executeTool } = await import("../src/services/assistant/agent/tools.js");
  const { buildAgentBundle } = await import("../src/services/assistant/agent/answer-bundle.js");
  const results = new Map();
  let n = 0;
  const req = { auth: { tenantId: tenant._id, role: "TENANT_OWNER", id: user._id }, scope: { tenantId: tenant._id }, query: {} };
  const ctx = { req, scope: { tenantId: tenant._id }, results, nextId: () => `r${++n}` };

  const rep = await executeTool("run_report", { reportKey: "COLLECTION", dateFrom: day, dateTo: day, purpose: "x" }, ctx);
  assert.ok(!rep.error, JSON.stringify(rep.error));
  assert.ok(rep.forModel.summary.length > 0);
  assert.ok(JSON.stringify(rep.forModel).includes("₹1,000"), JSON.stringify(rep.forModel));

  const trend = await executeTool("collection_trend", { dateFrom: day, dateTo: day, modes: ["CASH", "UPI"], purpose: "y" }, ctx);
  assert.ok(!trend.error, JSON.stringify(trend.error));
  assert.equal(results.get(trend.resultId).bundle.chart.series.length, 2);

  const single = await executeTool("collection_trend", { dateFrom: day, dateTo: day, modes: ["UPI"], purpose: "z" }, ctx);
  assert.equal(results.get(single.resultId).kind, "data");
  assert.equal(single.forModel.totals.sum_amount, "₹300");

  const perMode = await executeTool(
    "query_data",
    { entity: "payments", dateFrom: day, dateTo: day, timeBucket: "day", groupBy: ["mode"], metrics: [{ fn: "sum", field: "amount" }], compareToPrevious: true, purpose: "w" },
    ctx,
  );
  assert.ok(!perMode.error, JSON.stringify(perMode.error));
  assert.equal(perMode.forModel.previousPeriod.totals.sum_amount.value, "₹0");

  const bundle = buildAgentBundle({
    final: {
      answer: "ok",
      blocks: [
        { type: "stats", resultId: rep.resultId },
        { type: "chart", resultId: trend.resultId },
        { type: "chart", resultId: perMode.resultId },
        { type: "table", resultId: rep.resultId },
      ],
    },
    results,
    steps: [],
    calls: [],
    usage: null,
    model: "test",
  });
  assert.deepEqual(bundle.blocks.map((b) => b.type), ["stats", "chart", "chart", "table"]);
  const modeChart = bundle.blocks[2].chart;
  assert.deepEqual(modeChart.series.map((s) => s.name).sort(), ["Cash", "UPI"]);
  assert.equal(bundle.blocks[3].action.kind, "report");
});
