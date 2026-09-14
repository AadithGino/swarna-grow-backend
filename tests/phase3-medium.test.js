import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sanitize } from "../src/services/audit.service.js";
import { phonePeProvider } from "../src/integrations/phonepe.provider.js";
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

test("phonepe verifyWebhook rejects malformed JSON without throwing and uses timing-safe compare", () => {
  assert.equal(phonePeProvider.verifyWebhook("{not-json", "/callback", "anything", "salt", "1"), false);
  const payload = { response: Buffer.from("{}").toString("base64") };
  const raw = JSON.stringify(payload);
  const expected = createHash("sha256").update(`${payload.response}/callbacksalt`).digest("hex") + "###1";
  assert.equal(phonePeProvider.verifyWebhook(raw, "/callback", expected, "salt", "1"), true);
  assert.equal(phonePeProvider.verifyWebhook(raw, "/callback", expected.slice(0, -1) + "0", "salt", "1"), false);
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
