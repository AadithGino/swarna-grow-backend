import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { EcommerceCodRemittanceBatch } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { bearerFor, resetTestDb, seedFixture, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function seedBatch(tenantId, userId, statementReference, createdAt) {
  return EcommerceCodRemittanceBatch.create({
    _id: createId("ecrb"),
    tenantId,
    statementReference,
    status: "DRAFT",
    providerId: "MANUAL",
    createdByUserId: userId,
    createdAt,
  });
}

test("remittance batch list pagination and tenant isolation", async () => {
  const a = await seedFixture();
  const b = await seedFixture();
  const t0 = new Date("2026-04-01T10:00:00.000Z");
  const t1 = new Date("2026-04-02T10:00:00.000Z");
  const t2 = new Date("2026-04-03T10:00:00.000Z");
  const ba0 = await seedBatch(a.tenant._id, a.user._id, "STMT-A-0", t0);
  const ba1 = await seedBatch(a.tenant._id, a.user._id, "STMT-A-1", t1);
  const ba2 = await seedBatch(a.tenant._id, a.user._id, "STMT-A-2", t2);
  await seedBatch(b.tenant._id, b.user._id, "STMT-B-ONLY", t2);

  const page1 = await request(app)
    .get("/api/v1/admin/ecommerce/courier-cod/remittance-batches")
    .query({ limit: 2 })
    .set("authorization", `Bearer ${bearerFor(a.user)}`);
  assert.equal(page1.status, 200);
  assert.equal(page1.body.data.length, 2);
  assert.equal(page1.body.meta.hasMore, true);
  assert.ok(page1.body.meta.nextCursor);
  assert.equal(page1.body.data[0].statementReference, "STMT-A-2");
  assert.equal(page1.body.data[1].statementReference, "STMT-A-1");

  const page2 = await request(app)
    .get("/api/v1/admin/ecommerce/courier-cod/remittance-batches")
    .query({ limit: 2, cursor: page1.body.meta.nextCursor })
    .set("authorization", `Bearer ${bearerFor(a.user)}`);
  assert.equal(page2.status, 200);
  assert.equal(page2.body.data.length, 1);
  assert.equal(page2.body.data[0]._id, ba0._id);
  assert.equal(page2.body.meta.hasMore, false);

  const foreign = await request(app)
    .get(`/api/v1/admin/ecommerce/courier-cod/remittance-batches/${ba2._id}`)
    .set("authorization", `Bearer ${bearerFor(b.user)}`);
  assert.equal(foreign.status, 404);

  const isolated = await request(app)
    .get("/api/v1/admin/ecommerce/courier-cod/remittance-batches")
    .set("authorization", `Bearer ${bearerFor(b.user)}`);
  assert.equal(isolated.body.data.length, 1);
  assert.equal(isolated.body.data[0].statementReference, "STMT-B-ONLY");
  assert.ok([ba0._id, ba1._id, ba2._id].includes(page1.body.data[0]._id));
});
