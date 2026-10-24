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
import { PaymentStatus, TenantRole } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { setCalendarDateOverrideForTests, resetCalendarDateOverrideForTests } from "../src/lib/date.js";
import { resetTestDb, seedBranch, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

function authMatchFromPipeline(compiled) {
  const match = compiled.pipeline[0].$match;
  if (match.$and) return match.$and[0];
  return match;
}

function matchFieldFromPipeline(compiled, field) {
  const match = compiled.pipeline[0].$match;
  if (match[field] != null) return match[field];
  if (Array.isArray(match.$and)) {
    for (const clause of match.$and) {
      if (clause[field] != null) return clause[field];
    }
  }
  return undefined;
}

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
  const auth = authMatchFromPipeline(compiled);
  assert.equal(auth.tenantId, tenantId);
  assert.equal(auth.branchId, branchId);
  assert.ok(compiled.pipeline[0].$match.$and);
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
  const paidAt = matchFieldFromPipeline(compiled, "paidAt");
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
    const paidAt = matchFieldFromPipeline(compiled, "paidAt");
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

test("branch-scoped user cannot widen scope with branchId eq to another branch", () => {
  const tenantId = createId("tenant");
  const branchA = createId("branch");
  const branchB = createId("branch");
  assert.throws(
    () =>
      compileQuerySpec(
        { entity: "customers", filters: [{ field: "branchId", op: "eq", value: branchB }] },
        { tenantId, branchId: branchA },
      ),
    (err) => err instanceof AppError && err.code === "ASSISTANT_SCOPE",
  );
});

test("branch-scoped user cannot widen scope with branchId in", () => {
  const tenantId = createId("tenant");
  const branchA = createId("branch");
  const branchB = createId("branch");
  assert.throws(
    () =>
      compileQuerySpec(
        {
          entity: "customers",
          filters: [{ field: "branchId", op: "in", value: [branchB] }],
        },
        { tenantId, branchId: branchA },
      ),
    (err) => err instanceof AppError && err.code === "ASSISTANT_SCOPE",
  );
});

test("branch-scoped user rejects mixed permitted and forbidden branchId in", () => {
  const tenantId = createId("tenant");
  const branchA = createId("branch");
  const branchB = createId("branch");
  assert.throws(
    () =>
      compileQuerySpec(
        {
          entity: "customers",
          filters: [{ field: "branchId", op: "in", value: [branchA, branchB] }],
        },
        { tenantId, branchId: branchA },
      ),
    (err) => err instanceof AppError && err.code === "ASSISTANT_SCOPE",
  );
});

test("branch-scoped queries return only authorized branch rows", async () => {
  const { tenant, branch } = await seedTenantUser({ role: TenantRole.BRANCH_MANAGER });
  const otherBranch = await seedBranch({ tenantId: tenant._id, code: "BR2", name: "Other" });
  await Customer.create([
    {
      _id: createId("customer"),
      tenantId: tenant._id,
      branchId: branch._id,
      name: "Scoped",
      mobile: "+919900000011",
      customerNumber: "C-SC-1",
      status: "ACTIVE",
    },
    {
      _id: createId("customer"),
      tenantId: tenant._id,
      branchId: otherBranch._id,
      name: "Other Branch",
      mobile: "+919900000012",
      customerNumber: "C-SC-2",
      status: "ACTIVE",
    },
  ]);

  const compiled = compileQuerySpec(
    { entity: "customers", filters: [] },
    { tenantId: tenant._id, branchId: branch._id },
  );
  const { rows } = await runCompiledQuery(compiled);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Scoped");
});

test("tenant owner may filter by branch without branch scope", async () => {
  const { tenant, branch } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const otherBranch = await seedBranch({ tenantId: tenant._id, code: "BR3", name: "Pick Me" });
  await Customer.create([
    {
      _id: createId("customer"),
      tenantId: tenant._id,
      branchId: branch._id,
      name: "HQ Customer",
      mobile: "+919900000021",
      customerNumber: "C-OWN-1",
      status: "ACTIVE",
    },
    {
      _id: createId("customer"),
      tenantId: tenant._id,
      branchId: otherBranch._id,
      name: "Picked Branch",
      mobile: "+919900000022",
      customerNumber: "C-OWN-2",
      status: "ACTIVE",
    },
  ]);

  const compiled = compileQuerySpec(
    {
      entity: "customers",
      filters: [{ field: "branchId", op: "eq", value: otherBranch._id }],
    },
    { tenantId: tenant._id },
  );
  const { rows } = await runCompiledQuery(compiled);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Picked Branch");
});

test("compileQuerySpec isolates tenants at execution time", async () => {
  const first = await seedTenantUser({ tenantCode: "ISO1" });
  const second = await seedTenantUser({ tenantCode: "ISO2" });
  await Customer.create({
    _id: createId("customer"),
    tenantId: first.tenant._id,
    branchId: first.branch._id,
    name: "Tenant One",
    mobile: "+919900000031",
    customerNumber: "C-ISO-1",
    status: "ACTIVE",
  });
  await Customer.create({
    _id: createId("customer"),
    tenantId: second.tenant._id,
    branchId: second.branch._id,
    name: "Tenant Two",
    mobile: "+919900000032",
    customerNumber: "C-ISO-2",
    status: "ACTIVE",
  });

  const compiled = compileQuerySpec(
    { entity: "customers", filters: [] },
    { tenantId: first.tenant._id },
  );
  const { rows } = await runCompiledQuery(compiled);
  assert.ok(rows.every((row) => String(row.name) !== "Tenant Two"));
  assert.ok(rows.some((row) => row.name === "Tenant One"));
});

test("aggregates respect branch scope", async () => {
  const { tenant, branch } = await seedTenantUser({ role: TenantRole.BRANCH_MANAGER });
  const otherBranch = await seedBranch({ tenantId: tenant._id, code: "BR4", name: "Agg Other" });
  await Customer.create([
    {
      _id: createId("customer"),
      tenantId: tenant._id,
      branchId: branch._id,
      name: "Agg A",
      mobile: "+919900000041",
      customerNumber: "C-AGG-1",
      status: "ACTIVE",
    },
    {
      _id: createId("customer"),
      tenantId: tenant._id,
      branchId: otherBranch._id,
      name: "Agg B",
      mobile: "+919900000042",
      customerNumber: "C-AGG-2",
      status: "ACTIVE",
    },
  ]);

  const compiled = compileQuerySpec(
    {
      entity: "customers",
      filters: [],
      groupBy: "branchId",
      topN: 10,
    },
    { tenantId: tenant._id, branchId: branch._id },
  );
  const { rows } = await runCompiledQuery(compiled);
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0]._id?.key), String(branch._id));
});

test("branches entity scopes by document _id not branchId field", async () => {
  const { tenant, branch } = await seedTenantUser({ role: TenantRole.BRANCH_MANAGER });
  await seedBranch({ tenantId: tenant._id, code: "BR5", name: "Hidden Branch" });

  const compiled = compileQuerySpec(
    { entity: "branches", filters: [] },
    { tenantId: tenant._id, branchId: branch._id },
  );
  const auth = authMatchFromPipeline(compiled);
  assert.equal(String(auth._id), String(branch._id));
  assert.equal(auth.branchId, undefined);

  const { rows } = await runCompiledQuery(compiled);
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0]._id), String(branch._id));
});

test("compileQuerySpec combines timeBucket and groupBy in one group stage", () => {
  const compiled = compileQuerySpec(
    {
      entity: "collections",
      filters: [{ field: "status", op: "eq", value: "SUCCESS" }],
      timeBucket: "day",
      groupBy: "mode",
      aggregate: { fn: "sum", field: "amountPaise" },
      sort: "asc",
    },
    { tenantId: createId("tenant") },
  );
  const groupStage = compiled.pipeline.find((s) => s.$group);
  assert.ok(groupStage);
  assert.ok(groupStage.$group._id.bucket);
  assert.equal(groupStage.$group._id.key, "$mode");
  const sortStage = compiled.pipeline.find((s) => s.$sort);
  assert.deepEqual(sortStage.$sort, { "_id.bucket": 1 });
  assert.equal(compiled.timeSeries, true);
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
