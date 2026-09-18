import test from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "../src/services/audit.service.js";
import { beginIdempotency, completeIdempotency } from "../src/services/idempotency.service.js";
import { IdempotencyRecord } from "../src/models/index.js";
import { resetTestDb, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("sanitize preserves arrays instead of converting them to objects", () => {
  const result = sanitize({ tags: ["a", "b"], nested: [{ id: 1 }, { id: 2 }], password: "secret" });
  assert.deepEqual(result.tags, ["a", "b"]);
  assert.deepEqual(result.nested, [{ id: 1 }, { id: 2 }]);
  assert.equal(result.password, undefined);
});

test("stale PROCESSING idempotency records can be reclaimed after 60 seconds", async () => {
  const key = `idem-${Date.now()}`;
  const first = await beginIdempotency({ tenantId: "tnt_1", actorId: "user_1", endpoint: "POST /x", key, body: { a: 1 } });
  assert.equal(first.replay, false);
  await IdempotencyRecord.updateOne({ _id: first.record._id }, { $set: { createdAt: new Date(Date.now() - 61_000) } });
  const second = await beginIdempotency({ tenantId: "tnt_1", actorId: "user_1", endpoint: "POST /x", key, body: { a: 1 } });
  assert.equal(second.replay, false);
  await completeIdempotency(second.record, 200, { success: true });
});
