import test from "node:test";
import assert from "node:assert/strict";
import { PushBroadcast } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const LEGACY_INDEX = "tenantId_1_campaignBusinessKey_1";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("PushBroadcast unique campaignBusinessKey rejects duplicate gold-rate broadcasts", async () => {
  const { tenant } = await seedTenantUser({});
  const key = "scheme-gold-rate:grt_dup";
  await PushBroadcast.create({
    _id: createId("pb"),
    tenantId: tenant._id,
    sourceKind: "GOLD_RATE_NOTIFICATION",
    campaignBusinessKey: key,
    audience: "ALL_DEVICES",
    status: "COMPLETED",
    title: "A",
    body: "B",
    requestedBy: createId("usr"),
  });
  await assert.rejects(
    () => PushBroadcast.create({
      _id: createId("pb"),
      tenantId: tenant._id,
      sourceKind: "GOLD_RATE_NOTIFICATION",
      campaignBusinessKey: key,
      audience: "ALL_DEVICES",
      status: "QUEUED",
      title: "A2",
      body: "B2",
      requestedBy: createId("usr"),
    }),
  );
});

test("legacy partial index can be replaced with expanded filter", async () => {
  const collection = PushBroadcast.collection;
  const indexes = await collection.indexes();
  const hasLegacy = indexes.some((idx) => idx.name === LEGACY_INDEX);
  if (hasLegacy) {
    await collection.dropIndex(LEGACY_INDEX);
  }
  await collection.createIndex(
    { tenantId: 1, campaignBusinessKey: 1 },
    {
      name: LEGACY_INDEX,
      unique: true,
      partialFilterExpression: { sourceKind: "ECOMMERCE_PROMOTION" },
    },
  );
  await collection.dropIndex(LEGACY_INDEX);
  await PushBroadcast.createIndexes();
  const after = await collection.indexes();
  const upgraded = after.find((idx) => idx.name === LEGACY_INDEX);
  assert.ok(upgraded?.partialFilterExpression?.sourceKind?.$in?.includes("GOLD_RATE_NOTIFICATION"));
});
