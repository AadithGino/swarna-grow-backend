import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import "../src/lib/date.js";
import { createApp } from "../src/app.js";
import { PaymentStatus } from "../src/constants/enums.js";
import { Customer, Payment } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import {
  clearAssistInterpretForTests,
  setAssistInterpretForTests,
  setAssistNarrateForTests,
} from "../src/integrations/llm/provider.js";
import {
  bearerFor,
  resetTestDb,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";

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

test("POST /admin/assistant/chat returns report bundle", { timeout: 60_000 }, async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    schemeId: createId("scheme"),
    receiptNumber: "RCP-ASST-1",
    amountPaise: 50_000,
    status: PaymentStatus.SUCCESS,
    mode: "CASH",
    paidAt: new Date(),
    collectedBy: user._id,
    source: "STAFF_APP",
  });

  setAssistInterpretForTests(async () => ({
    kind: "report",
    reportKey: "COLLECTION",
    filters: { period: "THIS_MONTH" },
  }));
  setAssistNarrateForTests(async () => "This month you collected ₹500 across one payment at Head Office.");

  const res = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "Collection this month" });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.data.summaryText);
  assert.ok(Array.isArray(res.body.data.statCards));
  assert.ok(res.body.data.action?.kind === "report");
  assert.equal(res.body.data.narrative, "This month you collected ₹500 across one payment at Head Office.");
});

test("POST /admin/assistant/chat still succeeds when narration fails", { timeout: 60_000 }, async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    schemeId: createId("scheme"),
    receiptNumber: "RCP-ASST-2",
    amountPaise: 25_000,
    status: PaymentStatus.SUCCESS,
    mode: "CASH",
    paidAt: new Date(),
    collectedBy: user._id,
    source: "STAFF_APP",
  });

  setAssistInterpretForTests(async () => ({
    kind: "report",
    reportKey: "COLLECTION",
    filters: { period: "THIS_MONTH" },
  }));
  setAssistNarrateForTests(async () => {
    throw new Error("narrate down");
  });

  const res = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "Collection summary" });

  assert.equal(res.status, 200);
  assert.ok(res.body.data.summaryText);
  assert.ok(!res.body.data.narrative);
});

test("POST /admin/assistant/chat returns query bundle scoped to caller tenant", async () => {
  const tenantA = await seedTenantUser({ tenantCode: "TENANTA", mobile: "+919911111111" });
  const tenantB = await seedTenantUser({ tenantCode: "TENANTB", mobile: "+919922222222" });

  await Customer.create({
    _id: createId("customer"),
    tenantId: tenantA.tenant._id,
    branchId: tenantA.branch._id,
    name: "Tenant A Only",
    mobile: "+919933333333",
    customerNumber: "A-1",
    status: "ACTIVE",
  });
  await Customer.create({
    _id: createId("customer"),
    tenantId: tenantB.tenant._id,
    branchId: tenantB.branch._id,
    name: "Tenant B Only",
    mobile: "+919944444444",
    customerNumber: "B-1",
    status: "ACTIVE",
  });

  setAssistInterpretForTests(async () => ({
    kind: "query",
    spec: {
      entity: "customers",
      filters: [{ field: "name", op: "startsWith", value: "Tenant" }],
      limit: 20,
    },
  }));

  const res = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(tenantA.user)}`)
    .send({ message: "Customers starting with Tenant" });

  assert.equal(res.status, 200);
  const names = (res.body.data.table?.rows ?? []).map((row) => row.name).filter(Boolean);
  assert.ok(names.includes("Tenant A Only"));
  assert.ok(!names.includes("Tenant B Only"));
});

test("POST /admin/assistant/chat returns clarify when interpret throws", async () => {
  const { user } = await seedTenantUser({});
  setAssistInterpretForTests(async () => {
    throw new Error("LLM 502");
  });

  const res = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "anything" });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.vizHint, "clarify");
  assert.match(res.body.data.summaryText, /trouble reading/i);
});

test("POST /admin/assistant/chat returns 503 when assistant is disabled (no LLM stub)", async () => {
  const { user } = await seedTenantUser({});
  const res = await request(app)
    .post("/api/v1/admin/assistant/chat")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({ message: "Hello" });
  assert.equal(res.status, 503);
  assert.equal(res.body.error?.code, "ASSISTANT_DISABLED");
});
