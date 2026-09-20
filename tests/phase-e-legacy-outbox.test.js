import test from "node:test";
import assert from "node:assert/strict";
import { JobStatus } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import {
  LEGACY_ORPHAN_ERROR,
  reconcileLegacyMessageSendOutboxKeyset,
} from "../src/lib/legacy-message-send-outbox.js";
import { Message, OutboxEvent } from "../src/models/index.js";
import { processOutbox } from "../src/workers/processors.js";
import { resetTestDb, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("orphan message.send outbox is terminalized by worker without a Message row", async () => {
  const tenantId = createId("tenant");
  const outbox = await OutboxEvent.create({
    tenantId,
    topic: "message.send",
    key: "msg_missing",
    payload: { messageId: "msg_missing" },
    status: JobStatus.QUEUED,
  });
  await processOutbox({ data: { outboxEventId: String(outbox._id) }, attemptsMade: 0 });
  const row = await OutboxEvent.findById(outbox._id).lean();
  assert.equal(row.status, JobStatus.COMPLETED);
  assert.equal(row.error, LEGACY_ORPHAN_ERROR);
});

test("message.send outbox with Message completes without error", async () => {
  const tenantId = createId("tenant");
  const messageId = createId("message");
  await Message.create({
    _id: messageId,
    tenantId,
    type: "MANUAL_PUSH",
    status: "QUEUED",
    channel: "PUSH",
    templateKey: "MANUAL_PUSH",
    templateParams: {},
  });
  const outbox = await OutboxEvent.create({
    tenantId,
    topic: "message.send",
    key: messageId,
    payload: { messageId },
    status: JobStatus.QUEUED,
  });
  await processOutbox({ data: { outboxEventId: String(outbox._id) }, attemptsMade: 0 });
  const row = await OutboxEvent.findById(outbox._id).lean();
  assert.equal(row.status, JobStatus.COMPLETED);
  assert.equal(row.error, null);
});

test("reconcile script batch is idempotent and does not delete rows", async () => {
  const tenantId = createId("tenant");
  await OutboxEvent.create({
    tenantId,
    topic: "message.send",
    key: "orphan_a",
    payload: { messageId: "orphan_a" },
    status: JobStatus.QUEUED,
  });
  const first = await reconcileLegacyMessageSendOutboxKeyset();
  assert.equal(first.completed, 1);
  const second = await reconcileLegacyMessageSendOutboxKeyset();
  assert.equal(second.processed, 0);
  assert.equal(await OutboxEvent.countDocuments({ topic: "message.send" }), 1);
});
