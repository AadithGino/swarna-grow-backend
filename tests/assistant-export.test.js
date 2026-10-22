import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { PaymentStatus } from "../src/constants/enums.js";
import { Customer, Payment } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import {
  exportableFieldsForQuery,
  exportQuery,
} from "../src/services/assistant/assistant-export.service.js";
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
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

test("exportableFieldsForQuery rejects unknown fields at export time", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customerId = createId("customer");
  await Customer.create({
    _id: customerId,
    tenantId: tenant._id,
    branchId: branch._id,
    name: "Export Me",
    mobile: "9000000001",
    customerNumber: "C-EXP-1",
    status: "ACTIVE",
  });
  await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    schemeId: createId("scheme"),
    receiptNumber: "RCP-EXP-1",
    amountPaise: 10_000,
    status: PaymentStatus.SUCCESS,
    mode: "CASH",
    paidAt: new Date(),
    collectedBy: user._id,
    source: "STAFF_APP",
  });

  const spec = { entity: "collections", filters: [{ field: "status", op: "eq", value: "SUCCESS" }] };
  const allowed = exportableFieldsForQuery("collections", spec);
  assert.ok(allowed.includes("amountPaise"));

  await assert.rejects(
    () =>
      exportQuery(
        {
          auth: { id: user._id, tenantId: tenant._id, role: user.role },
          scope: { tenantId: tenant._id },
        },
        spec,
        { fields: ["totallyUnknownField"], format: "CSV" },
      ),
    (err) => err.code === "ASSISTANT_EXPORT_FIELD",
  );
});

test("exportQuery streams CSV for tenant-scoped collections", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customerId = createId("customer");
  await Customer.create({
    _id: customerId,
    tenantId: tenant._id,
    branchId: branch._id,
    name: "CSV Customer",
    mobile: "9000000002",
    customerNumber: "C-EXP-2",
    status: "ACTIVE",
  });
  await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    schemeId: createId("scheme"),
    receiptNumber: "RCP-CSV-1",
    amountPaise: 25_000,
    status: PaymentStatus.SUCCESS,
    mode: "UPI",
    paidAt: new Date(),
    collectedBy: user._id,
    source: "STAFF_APP",
  });

  const spec = { entity: "collections", filters: [{ field: "status", op: "eq", value: "SUCCESS" }] };
  const prepared = await exportQuery(
    {
      auth: { id: user._id, tenantId: tenant._id, role: user.role },
      scope: { tenantId: tenant._id },
    },
    spec,
    { fields: ["receiptNumber", "amountPaise"], format: "CSV" },
  );

  const chunks = [];
  for await (const row of prepared.cursor) {
    chunks.push(row);
  }
  assert.ok(chunks.some((r) => r.receiptNumber === "RCP-CSV-1"));
});

test("export uses aggregate cursor without loading all rows at once", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  let cursorFactoryCalled = false;
  const originalAggregate = Payment.aggregate.bind(Payment);
  Payment.aggregate = function patchedAggregate(pipeline) {
    const agg = originalAggregate(pipeline);
    const origCursor = agg.cursor;
    agg.cursor = function cursor(...args) {
      cursorFactoryCalled = true;
      return origCursor.apply(this, args);
    };
    return agg;
  };

  try {
    await exportQuery(
      {
        auth: { id: user._id, tenantId: tenant._id, role: user.role },
        scope: { tenantId: tenant._id },
      },
      {
        entity: "collections",
        filters: [{ field: "status", op: "eq", value: "SUCCESS" }],
      },
      { fields: ["receiptNumber"], format: "CSV" },
    );
    assert.equal(cursorFactoryCalled, true);
  } finally {
    Payment.aggregate = originalAggregate;
  }
});

test("POST /admin/assistant/export returns CSV attachment for query action", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customerId = createId("customer");
  await Customer.create({
    _id: customerId,
    tenantId: tenant._id,
    branchId: branch._id,
    name: "HTTP Export",
    mobile: "9000000003",
    customerNumber: "C-EXP-3",
    status: "ACTIVE",
  });
  await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    schemeId: createId("scheme"),
    receiptNumber: "RCP-HTTP-1",
    amountPaise: 15_000,
    status: PaymentStatus.SUCCESS,
    mode: "CASH",
    paidAt: new Date(),
    collectedBy: user._id,
    source: "STAFF_APP",
  });

  const res = await request(app)
    .post("/api/v1/admin/assistant/export")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({
      action: {
        kind: "query",
        spec: {
          entity: "collections",
          filters: [{ field: "status", op: "eq", value: "SUCCESS" }],
        },
      },
      fields: ["receiptNumber", "amountPaise"],
      format: "CSV",
    });

  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"] ?? "", /text\/csv/i);
  assert.match(String(res.text), /RCP-HTTP-1/);
});

test("POST /admin/assistant/export returns XLSX for query action", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    schemeId: createId("scheme"),
    receiptNumber: "RCP-XLSX-1",
    amountPaise: 5_000,
    status: PaymentStatus.SUCCESS,
    mode: "CASH",
    paidAt: new Date(),
    collectedBy: user._id,
    source: "STAFF_APP",
  });

  const res = await request(app)
    .post("/api/v1/admin/assistant/export")
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .send({
      action: {
        kind: "query",
        spec: {
          entity: "collections",
          filters: [{ field: "status", op: "eq", value: "SUCCESS" }],
        },
      },
      fields: ["receiptNumber"],
      format: "XLSX",
    });

  assert.equal(res.status, 200);
  assert.match(
    res.headers["content-type"] ?? "",
    /spreadsheetml|octet-stream/i,
  );
  assert.ok(res.headers["content-disposition"]?.includes(".xlsx"));
});
