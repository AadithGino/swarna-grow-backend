/**
 * Operator snapshot: queue depth, webhook backlog, stale payments, dead letters.
 * Run against production MongoDB/Redis with the same .env as workers.
 *
 * Usage: npm run ops:inspect
 */
import mongoose from "mongoose";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { connectRedis, disconnectRedis } from "../src/config/redis.js";
import { env } from "../src/config/env.js";
import { PaymentStatus, PaymentMode } from "../src/constants/enums.js";
import { JobStatus } from "../src/constants/enums.js";
import { Message, OutboxEvent, Payment, WebhookEvent } from "../src/models/index.js";
import { evaluateQueueHealth, getQueueHealthSnapshot } from "../src/lib/queue-health.js";

function printSection(title) {
  console.log(`\n=== ${title} ===`);
}

await connectDatabase();
try {
  await connectRedis().catch(() => {});

  printSection("Environment");
  console.log(JSON.stringify({ nodeEnv: env.NODE_ENV, providerMode: env.PROVIDER_MODE }, null, 2));

  printSection("Queue health (BullMQ + Mongo backlog)");
  const queueHealth = await getQueueHealthSnapshot();
  const evaluation = evaluateQueueHealth(queueHealth);
  console.log(JSON.stringify({ ...queueHealth, evaluation }, null, 2));

  printSection("Oldest queued customer message");
  const oldestQueued = await Message.findOne({ status: "QUEUED" })
    .sort({ createdAt: 1 })
    .select("_id tenantId type channel createdAt")
    .lean();
  console.log(oldestQueued ?? "none");

  printSection("Outbox backlog (QUEUED)");
  const outboxQueued = await OutboxEvent.countDocuments({ status: JobStatus.QUEUED });
  console.log({ outboxQueued });

  printSection("Webhook dead letter (latest 20)");
  const deadLetters = await WebhookEvent.find({ status: JobStatus.DEAD_LETTER })
    .sort({ updatedAt: -1 })
    .limit(20)
    .select("_id tenantId provider providerEventId error updatedAt")
    .lean();
  console.log(JSON.stringify(deadLetters, null, 2));

  printSection("Stale gateway payments (PENDING > 30 min)");
  const staleBefore = new Date(Date.now() - 30 * 60_000);
  const stalePending = await Payment.countDocuments({
    status: PaymentStatus.PENDING,
    mode: PaymentMode.ONLINE_GATEWAY,
    paidAt: { $lte: staleBefore },
  });
  console.log({ stalePendingGateway: stalePending });

  printSection("Replay (admin API)");
  console.log(
    "Requeue idempotently: POST /admin/operations/messaging/dead-letter/:id/requeue (tenant admin, MESSAGE_SEND).",
  );
  console.log(
    "Webhook events are replayed via replayWebhookEvent; safe to retry after fixing root cause.",
  );
} finally {
  await disconnectRedis().catch(() => {});
  await disconnectDatabase();
  await mongoose.disconnect();
}
