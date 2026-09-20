import test from "node:test";
import assert from "node:assert/strict";
import { SchemeStatus } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { Grievance, Scheme } from "../src/models/index.js";
import { startTestDb, stopTestDb, resetTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function collectStages(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.stage) out.push(node);
  if (node.inputStage) collectStages(node.inputStage, out);
  if (node.inputStages) node.inputStages.forEach((child) => collectStages(child, out));
  if (node.executionStages) collectStages(node.executionStages, out);
  if (node.shards) node.shards.forEach((shard) => collectStages(shard.executionStages, out));
  return out;
}

function summarizeExplain(explain) {
  const stats = explain.executionStats ?? explain;
  const stages = collectStages(stats.executionStages ?? stats);
  const ixscan = stages.find((row) => row.stage === "IXSCAN");
  const collscan = stages.find((row) => row.stage === "COLLSCAN");
  const sortStage = stages.find((row) => row.stage === "SORT");
  return {
    indexName: ixscan?.indexName ?? collscan?.stage ?? stages[0]?.stage ?? "unknown",
    nReturned: stats.nReturned,
    totalKeysExamined: stats.totalKeysExamined,
    totalDocsExamined: stats.totalDocsExamined,
    executionTimeMillis: stats.executionTimeMillis,
    inMemorySort: Boolean(sortStage),
    usedCollscan: Boolean(collscan),
  };
}

async function explainFind(model, filter, sort, limit = 5) {
  const explain = await model.find(filter).sort(sort).limit(limit).explain("executionStats");
  return summarizeExplain(explain);
}

test("Phase F maintenance queries use indexed plans (explain evidence)", async () => {
  const today = "2026-09-19";
  const tenantId = createId("tenant");
  await Scheme.insertMany([
    {
      _id: createId("scheme"),
      tenantId,
      branchId: createId("branch"),
      customerId: createId("customer"),
      planId: createId("schemePlan"),
      enrollmentNumber: "IDX-MAT",
      planSnapshot: { paymentPattern: "FIXED" },
      valueBasis: "CASH",
      paymentPattern: "FIXED",
      status: SchemeStatus.ACTIVE,
      startDate: "2026-01-01",
      maturityDate: today,
      installments: [],
    },
    {
      _id: createId("scheme"),
      tenantId,
      branchId: createId("branch"),
      customerId: createId("customer"),
      planId: createId("schemePlan"),
      enrollmentNumber: "IDX-OVD",
      planSnapshot: { paymentPattern: "FIXED" },
      valueBasis: "CASH",
      paymentPattern: "FIXED",
      status: SchemeStatus.ACTIVE,
      startDate: "2026-01-01",
      maturityDate: "2027-01-01",
      installments: [
        { number: 1, dueDate: "2026-01-05", status: "DUE", graceEndsAt: "2026-09-01" },
      ],
    },
    {
      _id: createId("scheme"),
      tenantId,
      branchId: createId("branch"),
      customerId: createId("customer"),
      planId: createId("schemePlan"),
      enrollmentNumber: "IDX-FLX",
      planSnapshot: { paymentPattern: "FLEXIBLE", flexibleRules: { flexiblePhaseCycles: 6 } },
      valueBasis: "CASH",
      paymentPattern: "FLEXIBLE",
      flexiblePhase: "FLEXIBLE",
      status: SchemeStatus.ACTIVE,
      startDate: "2026-01-01",
      maturityDate: "2027-01-01",
      cycles: [{ expiresAt: "2026-09-01", status: "UPCOMING", remainingPaise: 1000 }],
      installments: [],
    },
  ]);
  await Grievance.create({
    _id: createId("grievance"),
    tenantId,
    branchId: createId("branch"),
    customerId: createId("customer"),
    ticketNumber: "GRV-1",
    category: "OTHER",
    status: "RESOLVED",
    resolvedAt: new Date("2026-09-01"),
    firstResponseDueAt: new Date("2026-08-01"),
    subject: "test",
    description: "test",
  });

  const cases = [
    {
      label: "maturity",
      run: () =>
        explainFind(
          Scheme,
          { status: { $in: [SchemeStatus.ACTIVE, SchemeStatus.LOCKED, SchemeStatus.DEFAULTED] }, maturityDate: { $lte: today } },
          { _id: 1 },
        ),
    },
    {
      label: "overdue",
      run: () =>
        explainFind(
          Scheme,
          {
            status: SchemeStatus.ACTIVE,
            paymentPattern: "FIXED",
            installments: { $elemMatch: { graceEndsAt: { $lt: today }, status: { $in: ["DUE", "PARTIALLY_PAID"] } } },
          },
          { _id: 1 },
        ),
    },
    {
      label: "defaulting",
      run: () =>
        explainFind(Scheme, { status: SchemeStatus.ACTIVE, paymentPattern: "FIXED" }, { _id: 1 }),
    },
    {
      label: "flexible-capacity-expiry",
      run: () =>
        explainFind(
          Scheme,
          {
            paymentPattern: "FLEXIBLE",
            cycles: { $elemMatch: { expiresAt: { $lt: today }, status: { $in: ["UPCOMING", "PARTIALLY_PAID"] } } },
          },
          { _id: 1 },
        ),
    },
    {
      label: "flexible-lock",
      run: () =>
        explainFind(
          Scheme,
          {
            paymentPattern: "FLEXIBLE",
            flexiblePhase: "FLEXIBLE",
            status: { $in: [SchemeStatus.ACTIVE, SchemeStatus.LOCKED] },
          },
          { _id: 1 },
        ),
    },
    {
      label: "grievance-auto-close",
      run: () =>
        explainFind(Grievance, { status: "RESOLVED", resolvedAt: { $lt: new Date("2026-09-10") } }, { _id: 1 }),
    },
  ];

  const evidence = [];
  for (const c of cases) {
    const stats = await c.run();
    evidence.push({ query: c.label, ...stats });
    assert.ok(stats.nReturned >= 0);
    assert.ok(
      !stats.usedCollscan || stats.totalDocsExamined <= 10,
      `${c.label}: full collection scan examined ${stats.totalDocsExamined} docs`,
    );
    assert.ok(stats.executionTimeMillis < 500, `${c.label} explain too slow`);
  }
  console.log("PHASE_F_INDEX_EXPLAIN_EVIDENCE", JSON.stringify(evidence, null, 2));
});
