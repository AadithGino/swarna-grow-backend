import test from "node:test";
import assert from "node:assert/strict";
import {
  broadcastIdempotencyKey,
  deterministicBroadcastMessageId,
} from "../src/lib/broadcast-message-id.js";
import { selectFairMessageBatch } from "../src/lib/fair-message-dispatch.js";
import { buildBroadcastChunkWrites } from "../src/services/push-broadcast.service.js";

test("deterministic broadcast message ids are stable", () => {
  const a = deterministicBroadcastMessageId("tnt_1", "pbc_1", "cus_1");
  const b = deterministicBroadcastMessageId("tnt_1", "pbc_1", "cus_1");
  const c = deterministicBroadcastMessageId("tnt_1", "pbc_1", "cus_2");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^msg_[a-f0-9]{26}$/);
});

test("broadcast idempotency key includes tenant broadcast customer channel", () => {
  assert.equal(
    broadcastIdempotencyKey("tnt_1", "pbc_1", "cus_1"),
    "tnt_1:pbc_1:cus_1:PUSH",
  );
});

test("buildBroadcastChunkWrites uses deterministic ids without redundant outbox", () => {
  const { messageOps, outboxOps } = buildBroadcastChunkWrites({
    broadcast: {
      _id: "pbc_1",
      tenantId: "tnt_1",
      title: "Hi",
      body: "There",
      deepLink: "/home",
    },
    customers: [{ _id: "cus_1", branchId: "brn_1" }],
  });
  assert.equal(messageOps.length, 1);
  assert.equal(outboxOps.length, 0);
  const messageId = deterministicBroadcastMessageId("tnt_1", "pbc_1", "cus_1");
  assert.equal(messageOps[0].updateOne.filter._id, messageId);
  assert.equal(messageOps[0].updateOne.update.$setOnInsert.dispatchPriority, 10);
});

test("fair dispatch caps per tenant and global batch", () => {
  const rows = [
    { _id: "1", tenantId: "A", dispatchPriority: 0, createdAt: new Date(1) },
    { _id: "2", tenantId: "A", dispatchPriority: 0, createdAt: new Date(2) },
    { _id: "3", tenantId: "B", dispatchPriority: 0, createdAt: new Date(3) },
    { _id: "4", tenantId: "A", dispatchPriority: 0, createdAt: new Date(4) },
  ];
  const picked = selectFairMessageBatch(rows, { perTenant: 1, global: 3 });
  assert.deepEqual(picked.map((row) => row._id), ["1", "3"]);
});
