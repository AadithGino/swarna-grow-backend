import test from "node:test";
import assert from "node:assert/strict";
import "../src/lib/date.js";
import { AppError } from "../src/lib/app-error.js";
import {
  compileQuerySpec,
  runCompiledQuery,
  toIstBoundary,
} from "../src/services/assistant/query-compiler.js";
import { ASSISTANT_MAX_TIME_MS, ASSISTANT_ROW_CAP } from "../src/services/assistant/schema-registry.js";
import { validateAssistantAction } from "../src/validators/assistant.validators.js";
import { Customer, Payment } from "../src/models/index.js";
import { PaymentStatus } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { setCalendarDateOverrideForTests, resetCalendarDateOverrideForTests } from "../src/lib/date.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

test("compileQuerySpec always injects tenant scope as first $match", () => {
  const tenantId = createId("tenant");
  const branchId = createId("branch");
  const compiled = compileQuerySpec(
    {
      entity: "customers",
      filters: [{ field: "status", op: "eq", value: "ACTIVE" }],
    },
    { tenantId, branchId },
  );
  assert.equal(compiled.pipeline[0].$match.tenantId, tenantId);
  assert.equal(compiled.pipeline[0].$match.branchId, branchId);
});

test("validateAssistantAction rejects unknown query fields", () => {
  assert.throws(
    () =>
      validateAssistantAction({
        kind: "query",
        spec: {
          entity: "customers",
          filters: [{ field: "secretField", op: "eq", value: "x" }],
        },
      }),
    (err) => err instanceof AppError && err.code === "ASSISTANT_INVALID_FIELD",
  );
});

test("compileQuerySpec enforces row cap via limit stage", () => {
  const compiled = compileQuerySpec(
    { entity: "customers", filters: [], limit: 900 },
    { tenantId: createId("tenant") },
  );
  const limitStage = compiled.pipeline.find((stage) => stage.$limit != null);
  assert.ok(limitStage);
  assert.equal(limitStage.$limit, ASSISTANT_ROW_CAP + 1);
  assert.equal(compiled.limit, ASSISTANT_ROW_CAP);
});

test("group-by branchId aggregation shapes top-N rows", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const otherBranch = createId("branch");
  await Customer.create([
    {
      _id: createId("customer"),
      tenantId: tenant._id,
      branchId: branch._id,
      name: "Alpha",
      mobile: "+919900000001",
      customerNumber: "C-1",
      status: "ACTIVE",
    },
    {
      _id: createId("customer"),
      tenantId: tenant._id,
      branchId: otherBranch,
      name: "Beta",
      mobile: "+919900000002",
      customerNumber: "C-2",
      status: "ACTIVE",
    },
  ]);

  const compiled = compileQuerySpec(
    {
      entity: "customers",
      filters: [],
      groupBy: "branchId",
      topN: 5,
      sort: "desc",
    },
    { tenantId: tenant._id },
  );
  assert.ok(compiled.pipeline.some((stage) => stage.$group));
  const { rows } = await runCompiledQuery(compiled);
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((row) => row._id?.key === branch._id || row._id?.key === otherBranch));
});

test("between filter on paidAt uses Date bounds in $match", () => {
  const compiled = compileQuerySpec(
    {
      entity: "collections",
      filters: [{ field: "paidAt", op: "between", value: "2026-09-01", valueTo: "2026-09-30" }],
    },
    { tenantId: createId("tenant") },
  );
  const paidAt = compiled.pipeline[0].$match.paidAt;
  assert.ok(paidAt.$gte instanceof Date);
  assert.ok(paidAt.$lte instanceof Date);
  assert.equal(paidAt.$gte.toISOString().slice(0, 10), "2026-08-31");
});

test("period LAST_MONTH adds paidAt Date range on collections", () => {
  setCalendarDateOverrideForTests("2026-10-15");
  try {
    const compiled = compileQuerySpec(
      { entity: "collections", period: "LAST_MONTH", filters: [] },
      { tenantId: createId("tenant") },
    );
    const paidAt = compiled.pipeline[0].$match.paidAt;
    assert.ok(paidAt.$gte instanceof Date);
    assert.ok(paidAt.$lte instanceof Date);
    assert.equal(paidAt.$gte.toISOString().slice(0, 10), "2026-08-31");
    assert.equal(paidAt.$lte.toISOString().slice(0, 10), "2026-09-30");
  } finally {
    resetCalendarDateOverrideForTests();
  }
});

test("sum aggregate sorts grouped pipeline by total", () => {
  const compiled = compileQuerySpec(
    {
      entity: "collections",
      filters: [],
      groupBy: "customerId",
      aggregate: { fn: "sum", field: "amountPaise" },
      sort: "desc",
    },
    { tenantId: createId("tenant") },
  );
  const sortStage = compiled.pipeline.find((stage) => stage.$sort);
  assert.deepEqual(sortStage.$sort, { total: -1, count: -1 });
});

test("customerId group lookup adds label after limit", () => {
  const compiled = compileQuerySpec(
    {
      entity: "collections",
      filters: [],
      groupBy: "customerId",
      aggregate: { fn: "sum", field: "amountPaise" },
      topN: 3,
    },
    { tenantId: createId("tenant") },
  );
  assert.ok(compiled.pipeline.some((stage) => stage.$lookup?.from === "customers"));
  assert.ok(compiled.pipeline.some((stage) => stage.$addFields?.label));
});

test("last-month grouped collections return tenant-scoped rows with labels", async () => {
  setCalendarDateOverrideForTests("2026-10-15");
  try {
    const { tenant, branch, user } = await seedTenantUser({});
    const topCustomer = await Customer.create({
      _id: createId("customer"),
      tenantId: tenant._id,
      branchId: branch._id,
      name: "Top Payer",
      mobile: "+919900000099",
      customerNumber: "C-TOP",
      status: "ACTIVE",
    });
    const otherCustomer = await Customer.create({
      _id: createId("customer"),
      tenantId: tenant._id,
      branchId: branch._id,
      name: "Small Payer",
      mobile: "+919900000098",
      customerNumber: "C-SML",
      status: "ACTIVE",
    });
    await Payment.create([
      {
        _id: createId("payment"),
        tenantId: tenant._id,
        branchId: branch._id,
        customerId: topCustomer._id,
        schemeId: createId("scheme"),
        receiptNumber: "RCP-LM-1",
        amountPaise: 100_000,
        status: PaymentStatus.SUCCESS,
        mode: "CASH",
        paidAt: new Date("2026-09-10T12:00:00+05:30"),
        collectedBy: user._id,
        source: "STAFF_APP",
      },
      {
        _id: createId("payment"),
        tenantId: tenant._id,
        branchId: branch._id,
        customerId: otherCustomer._id,
        schemeId: createId("scheme"),
        receiptNumber: "RCP-LM-2",
        amountPaise: 10_000,
        status: PaymentStatus.SUCCESS,
        mode: "CASH",
        paidAt: new Date("2026-09-12T12:00:00+05:30"),
        collectedBy: user._id,
        source: "STAFF_APP",
      },
    ]);

    const compiled = compileQuerySpec(
      {
        entity: "collections",
        period: "LAST_MONTH",
        groupBy: "customerId",
        aggregate: { fn: "sum", field: "amountPaise" },
        sort: "desc",
        topN: 5,
      },
      { tenantId: tenant._id },
    );
    const { rows } = await runCompiledQuery(compiled);
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].label, "Top Payer");
    assert.equal(rows[0].total, 100_000);
  } finally {
    resetCalendarDateOverrideForTests();
  }
});

test("toIstBoundary parses YYYY-MM-DD in IST", () => {
  const start = toIstBoundary("2026-09-01");
  const end = toIstBoundary("2026-09-30", true);
  assert.ok(start instanceof Date);
  assert.ok(end instanceof Date);
  assert.ok(end.getTime() > start.getTime());
});

test("runCompiledQuery applies maxTimeMS on aggregate", async () => {
  const original = Customer.aggregate;
  let capturedOptions = null;
  Customer.aggregate = function mockAggregate(pipeline) {
    return {
      option(opts) {
        capturedOptions = opts;
        return original.call(Customer, pipeline).option(opts);
      },
    };
  };
  try {
    const { tenant } = await seedTenantUser({});
    const compiled = compileQuerySpec({ entity: "customers", filters: [] }, { tenantId: tenant._id });
    await runCompiledQuery(compiled);
    assert.equal(capturedOptions?.maxTimeMS, ASSISTANT_MAX_TIME_MS);
  } finally {
    Customer.aggregate = original;
  }
});
