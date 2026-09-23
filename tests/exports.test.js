import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { downloadExportFile } from "../src/services/reporting.service.js";
import { processExport } from "../src/workers/processors.js";
import { Customer, ExportJob } from "../src/models/index.js";
import { ExportStatus, PaymentSource } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("processExport stores object key in shared storage and downloadExportFile reads via storageProvider", async () => {
  const { tenant, user } = await seedTenantUser();
  const customerId = createId("customer");
  await Customer.create({
    _id: customerId,
    tenantId: tenant._id,
    name: "Export Customer",
    mobile: "+919811199988",
    customerNumber: "CUST-EXP-1",
  });
  const exportId = createId("export");
  await ExportJob.create({
    _id: exportId,
    tenantId: tenant._id,
    requestedBy: user._id,
    type: "CUSTOMER",
    status: ExportStatus.QUEUED,
    filters: { format: "CSV" },
    scopeSnapshot: { tenantId: tenant._id, branchId: null },
  });
  await processExport({ data: { exportId } });
  const job = await ExportJob.findById(exportId).lean();
  assert.equal(job.status, ExportStatus.READY);
  assert.match(job.objectKey, /^exports\/.+\/.+\.csv$/);
  assert.equal(path.isAbsolute(job.objectKey), false);
  assert.equal(job.objectKey.includes(path.resolve("exports")), false);

  const chunks = [];
  const res = {
    setHeader() {},
    send(body) { chunks.push(body); },
  };
  await downloadExportFile({
    auth: { tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id },
    params: { exportId },
  }, res);
  const csv = Buffer.concat(chunks).toString("utf8");
  assert.match(csv, /Export Customer/);
  assert.equal(fs.existsSync(path.resolve("exports", `${exportId}.csv`)), false);
});

test("processExport escapes csv formula injection in customer names", async () => {
  const { tenant, user } = await seedTenantUser();
  const customerId = createId("customer");
  await Customer.create({
    _id: customerId,
    tenantId: tenant._id,
    name: "=1+1",
    mobile: "+919811199977",
    customerNumber: "CUST-EXP-2",
  });
  const exportId = createId("export");
  await ExportJob.create({
    _id: exportId,
    tenantId: tenant._id,
    requestedBy: user._id,
    type: "CUSTOMER",
    status: ExportStatus.QUEUED,
    filters: { format: "CSV" },
    scopeSnapshot: { tenantId: tenant._id, branchId: null },
  });
  await processExport({ data: { exportId } });
  const chunks = [];
  await downloadExportFile({
    auth: { tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id },
    params: { exportId },
  }, { setHeader() {}, send(body) { chunks.push(body); } });
  const csv = Buffer.concat(chunks).toString("utf8");
  assert.match(csv, /'=1\+1/);
});

test("processExport uses report builder for COLLECTION instead of raw Payment rows", async () => {
  const { tenant, user, branch } = await seedTenantUser();
  const { Payment } = await import("../src/models/index.js");
  const schemeId = createId("scheme");
  const customerId = createId("customer");
  await Customer.create({
    _id: customerId,
    tenantId: tenant._id,
    branchId: branch._id,
    name: "Collection Customer",
    mobile: "+919811188800",
    customerNumber: "CUST-COL-1",
  });
  await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId,
    customerId,
    receiptNumber: "RCPT-COL-1",
    amountPaise: 50000,
    mode: "CASH",
    source: PaymentSource.STAFF_APP,
    status: "SUCCESS",
    paidAt: new Date("2026-01-15T10:00:00+05:30"),
  });
  const exportId = createId("export");
  await ExportJob.create({
    _id: exportId,
    tenantId: tenant._id,
    requestedBy: user._id,
    type: "COLLECTION",
    status: ExportStatus.QUEUED,
    filters: { from: "2026-01-01", to: "2026-01-31", format: "CSV" },
    scopeSnapshot: { tenantId: tenant._id, branchId: branch._id },
  });
  await processExport({ data: { exportId } });
  const job = await ExportJob.findById(exportId).lean();
  assert.equal(job.status, ExportStatus.READY);
  const chunks = [];
  await downloadExportFile({
    auth: { tenantId: tenant._id },
    params: { exportId },
  }, { setHeader() {}, send(body) { chunks.push(body); } });
  const csv = Buffer.concat(chunks).toString("utf8");
  assert.match(csv, /Showroom/);
  assert.doesNotMatch(csv, /receiptNumber/);
});

test("processExport fails unsupported export types instead of dumping Payment rows", async () => {
  const { tenant, user } = await seedTenantUser();
  const exportId = createId("export");
  await ExportJob.create({
    _id: exportId,
    tenantId: tenant._id,
    requestedBy: user._id,
    type: "DUE",
    status: ExportStatus.QUEUED,
    filters: { format: "CSV" },
    scopeSnapshot: { tenantId: tenant._id, branchId: null },
  });
  await assert.rejects(
    () => processExport({ data: { exportId } }),
    (error) => error.code === "EXPORT_TYPE_NOT_SUPPORTED",
  );
  const job = await ExportJob.findById(exportId).lean();
  assert.equal(job.status, ExportStatus.FAILED);
});
