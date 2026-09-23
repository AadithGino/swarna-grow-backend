import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/lib/app-error.js";
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

test("stale PROCESSING idempotency records are reclaimed once the lease expires", async () => {
  const key = `idem-${Date.now()}`;
  const ctx = { tenantId: "tnt_1", actorId: "user_1", endpoint: "POST /x", key, body: { a: 1 } };
  const first = await beginIdempotency(ctx);
  assert.equal(first.replay, false);
  await IdempotencyRecord.updateOne(
    { _id: first.record._id },
    { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } },
  );
  const second = await beginIdempotency(ctx);
  assert.equal(second.replay, false);
  assert.notEqual(second.record.leaseOwner, first.record.leaseOwner);
  await completeIdempotency(second.record, 200, { success: true });
});

test("PROCESSING idempotency with active lease rejects duplicate begin", async () => {
  const key = `idem-active-${Date.now()}`;
  const ctx = { tenantId: "tnt_1", actorId: "user_1", endpoint: "POST /x", key, body: { a: 1 } };
  await beginIdempotency(ctx);
  await assert.rejects(
    () => beginIdempotency(ctx),
    (err) => err instanceof AppError && err.code === "REQUEST_IN_PROGRESS" && err.statusCode === 409,
  );
});
