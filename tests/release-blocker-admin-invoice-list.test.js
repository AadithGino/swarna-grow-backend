import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createId } from "../src/lib/ids.js";
import { Invoice } from "../src/models/index.js";
import { listSubscriptionInvoicesForAdmin } from "../src/services/tenant-settings.service.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

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

test("admin invoice list uses invoiceNumber as number with reference separate", async () => {
  const { tenant, user } = await seedTenantUser({});
  const invoiceId = createId("inv");
  await Invoice.create({
    _id: invoiceId,
    tenantId: tenant._id,
    invoiceNumber: "PLT/2026/0042",
    reference: "PAY-REF-99",
    amountPaise: 59_000,
    status: "PAID",
    paidAt: new Date("2026-03-01T00:00:00.000Z"),
  });

  const rows = await listSubscriptionInvoicesForAdmin({
    auth: { tenantId: tenant._id },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].number, "PLT/2026/0042");
  assert.equal(rows[0].invoiceNumber, "PLT/2026/0042");
  assert.equal(rows[0].reference, "PAY-REF-99");

  const res = await request(app)
    .get("/api/v1/admin/subscription/invoices")
    .set("authorization", `Bearer ${bearerFor(user)}`);
  assert.equal(res.status, 200);
  const listed = res.body.data.find((row) => row.id === invoiceId);
  assert.ok(listed);
  assert.equal(listed.number, "PLT/2026/0042");
  assert.equal(listed.invoiceNumber, "PLT/2026/0042");
  assert.equal(listed.reference, "PAY-REF-99");
});

test("admin invoice list legacy row falls back reference then id", async () => {
  const { tenant } = await seedTenantUser({});
  const invoiceId = createId("inv");
  await Invoice.create({
    _id: invoiceId,
    tenantId: tenant._id,
    reference: "LEGACY-REF-1",
    amountPaise: 1000,
    status: "ISSUED",
  });

  const rows = await listSubscriptionInvoicesForAdmin({
    auth: { tenantId: tenant._id },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].number, "LEGACY-REF-1");
  assert.equal(rows[0].invoiceNumber, null);
  assert.equal(rows[0].reference, "LEGACY-REF-1");

  await Invoice.updateOne({ _id: invoiceId }, { $unset: { reference: 1 } });
  const fallback = await listSubscriptionInvoicesForAdmin({
    auth: { tenantId: tenant._id },
  });
  assert.equal(fallback[0].number, invoiceId);
  assert.equal(fallback[0].invoiceNumber, null);
  assert.equal(fallback[0].reference, null);
});
