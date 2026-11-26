import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { Permission } from "../src/constants/permissions.js";
import { GoldRate } from "../src/models/index.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { createId } from "../src/lib/ids.js";

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

test("GET gold-rate/history with branch filter includes tenant-wide rates", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await GoldRate.create({
    _id: createId("grt"),
    tenantId: tenant._id,
    branchId: null,
    effectiveDate: "2026-06-15",
    ratePerGramPaise: 725_000,
    purity: "22K",
    enteredBy: user._id,
  });

  const withBranch = await request(app)
    .get("/api/v1/admin/gold-rate/history")
    .query({ branchId: branch._id, limit: 10 })
    .set({ authorization: `Bearer ${bearerFor(user, [Permission.GOLD_RATE_READ])}` });

  assert.equal(withBranch.status, 200);
  const items = withBranch.body.data ?? [];
  assert.ok(Array.isArray(items), "expected list payload");
  assert.equal(items.length, 1);
  assert.equal(items[0].ratePerGramPaise, 725_000);

  const tenantWideOnly = await request(app)
    .get("/api/v1/admin/gold-rate/history")
    .query({ branchId: "null", limit: 10 })
    .set({ authorization: `Bearer ${bearerFor(user, [Permission.GOLD_RATE_READ])}` });

  assert.equal(tenantWideOnly.status, 200);
  const wideItems = tenantWideOnly.body.data ?? [];
  assert.equal(wideItems.length, 1);

  await GoldRate.create({
    _id: createId("grt"),
    tenantId: tenant._id,
    branchId: branch._id,
    effectiveDate: "2026-06-16",
    ratePerGramPaise: 730_000,
    purity: "22K",
    enteredBy: user._id,
  });

  const otherBranch = await seedTenantUser({ tenantCode: "OTHBR", branchCode: "OTH" });
  await GoldRate.create({
    _id: createId("grt"),
    tenantId: tenant._id,
    branchId: otherBranch.branch._id,
    effectiveDate: "2026-06-16",
    ratePerGramPaise: 740_000,
    purity: "22K",
    enteredBy: user._id,
  });

  const filtered = await request(app)
    .get("/api/v1/admin/gold-rate/history")
    .query({ branchId: branch._id, limit: 20 })
    .set({ authorization: `Bearer ${bearerFor(user, [Permission.GOLD_RATE_READ])}` });

  const filteredItems = filtered.body.data ?? [];
  assert.equal(filteredItems.length, 2);
  assert.ok(
    filteredItems.every(
      (row) => row.branchId == null || row.branchId === branch._id,
    ),
  );
});

test("GET gold-rate/current with branch filter resolves tenant-wide rate", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await GoldRate.create({
    _id: createId("grt"),
    tenantId: tenant._id,
    branchId: null,
    effectiveDate: "2026-06-15",
    ratePerGramPaise: 725_000,
    purity: "22K",
    enteredBy: user._id,
  });

  const res = await request(app)
    .get("/api/v1/admin/gold-rate/current")
    .query({ branchId: branch._id, date: "2026-06-15" })
    .set({ authorization: `Bearer ${bearerFor(user, [Permission.GOLD_RATE_READ])}` });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.ratePerGramPaise, 725_000);
  assert.equal(res.body.data.isSetForToday, true);
});