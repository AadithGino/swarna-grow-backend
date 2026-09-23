import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { PaymentSource, TenantRole } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { ExportJob, Payment } from "../src/models/index.js";
import { processExport } from "../src/workers/processors.js";
import { downloadExportFile, getExport } from "../src/services/reporting.service.js";
import {
  bearerFor,
  resetTestDb,
  seedBranch,
  seedCustomer,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";
import { seedUserOnTenant } from "./helpers/gateway-http-fixture.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("branch manager export ignores foreign branchId in filters and scopes worker output", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const branchB = await seedBranch({ tenantId: tenant._id, code: "BRB", name: "Branch B" });
  const customerA = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile: "+919811100001" });
  const customerB = await seedCustomer({ tenantId: tenant._id, branchId: branchB._id, mobile: "+919811100002" });
  const schemeA = createId("scheme");
  const schemeB = createId("scheme");
  await Payment.insertMany([
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: schemeA,
      customerId: customerA._id,
      receiptNumber: "RCPT-A",
      amountPaise: 50_000,
      mode: "CASH",
      source: PaymentSource.STAFF_APP,
      status: "SUCCESS",
      paidAt: new Date("2026-01-15T10:00:00+05:30"),
      collectedBy: user._id,
    },
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branchB._id,
      schemeId: schemeB,
      customerId: customerB._id,
      receiptNumber: "RCPT-B",
      amountPaise: 90_000,
      mode: "CASH",
      source: PaymentSource.STAFF_APP,
      status: "SUCCESS",
      paidAt: new Date("2026-01-16T10:00:00+05:30"),
      collectedBy: user._id,
    },
  ]);
  const manager = await seedUserOnTenant({
    tenantId: tenant._id,
    branchId: branch._id,
    role: TenantRole.BRANCH_MANAGER,
    mobile: "+919700000099",
  });
  const createRes = await request(app)
    .post("/api/v1/admin/exports")
    .set("authorization", `Bearer ${manager.token}`)
    .set("x-idempotency-key", "export-scope-branch-mgr")
    .send({
      type: "COLLECTION",
      format: "CSV",
      filters: { from: "2026-01-01", to: "2026-01-31", branchId: branchB._id },
    })
    .expect(202);
  const exportId = createRes.body.data.exportId;
  const job = await ExportJob.findById(exportId).lean();
  assert.equal(job.scopeSnapshot.branchId, branch._id);
  assert.equal(job.filters.branchId, undefined);
  await processExport({ data: { exportId } });
  const chunks = [];
  await downloadExportFile(
    {
      auth: { tenantId: tenant._id, type: "TENANT_USER" },
      scope: { tenantId: tenant._id, branchId: branch._id },
      params: { exportId },
    },
    { setHeader() {}, send(body) { chunks.push(body); } },
  );
  const csv = Buffer.concat(chunks).toString("utf8");
  assert.match(csv, /₹500/);
  assert.doesNotMatch(csv, /₹900/);
});

test("branch manager cannot download tenant-wide export created by owner", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const exportId = createId("export");
  await ExportJob.create({
    _id: exportId,
    tenantId: tenant._id,
    requestedBy: user._id,
    type: "CUSTOMER",
    status: "READY",
    scopeSnapshot: { tenantId: tenant._id, branchId: null },
    filters: { format: "CSV" },
    objectKey: "exports/test.csv",
    downloadExpiresAt: new Date(Date.now() + 86_400_000),
  });
  await seedUserOnTenant({
    tenantId: tenant._id,
    branchId: branch._id,
    role: TenantRole.BRANCH_MANAGER,
    mobile: "+919700000088",
  });
  await assert.rejects(
    () =>
      getExport({
        auth: { tenantId: tenant._id, type: "TENANT_USER" },
        scope: { tenantId: tenant._id, branchId: branch._id },
        params: { exportId },
      }),
    (error) => error.statusCode === 404,
  );
});

test("tenant admin can create export scoped to selected branch", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_ADMIN });
  const branchB = await seedBranch({ tenantId: tenant._id, code: "BRX", name: "Branch X" });
  const res = await request(app)
    .post("/api/v1/admin/exports")
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", "export-admin-branch-pick")
    .send({
      type: "CUSTOMER",
      format: "CSV",
      filters: { branchId: branchB._id },
    })
    .expect(202);
  const job = await ExportJob.findById(res.body.data.exportId).lean();
  assert.equal(job.scopeSnapshot.branchId, branchB._id);
  assert.notEqual(job.scopeSnapshot.branchId, branch._id);
});
