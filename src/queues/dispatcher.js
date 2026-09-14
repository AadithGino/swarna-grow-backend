import { Message, OutboxEvent, WebhookEvent } from "../models/index.js";
import { getQueue } from "./index.js";
import { logger } from "../config/logger.js";

let timer;
async function dispatch() {
  try {
    const [outbox, messages, webhooks] = await Promise.all([
      OutboxEvent.find({ status: "QUEUED", availableAt: { $lte: new Date() } }).sort({ createdAt: 1 }).limit(100).lean(),
      Message.find({ status: "QUEUED" }).sort({ createdAt: 1 }).limit(100).lean(),
      WebhookEvent.find({ status: "QUEUED" }).sort({ createdAt: 1 }).limit(100).lean(),
    ]);
    const outboxQueue = getQueue("outbox"); const messageQueue = getQueue("messages"); const webhookQueue = getQueue("webhooks");
    if (!outboxQueue || !messageQueue || !webhookQueue) return;
    await Promise.all(outbox.map((row) => outboxQueue.add(row.topic, { outboxEventId: row._id }, { jobId: row._id, attempts: 5, backoff: { type: "exponential", delay: 2000 } })));
    await Promise.all(messages.map((row) => messageQueue.add(row.type, { messageId: row._id }, { jobId: row._id, attempts: 5, backoff: { type: "exponential", delay: 5000 } })));
    await Promise.all(webhooks.map((row) => webhookQueue.add(row.provider, { webhookEventId: row._id }, { jobId: row._id, attempts: 5, backoff: { type: "exponential", delay: 5000 } })));
  } catch (error) { logger.error({ err: error }, "Outbox dispatch failed"); }
}
export function startDispatcher() { if (!timer) { timer = setInterval(() => void dispatch(), 2000); timer.unref(); void dispatch(); } }
export function stopDispatcher() { if (timer) clearInterval(timer); timer = undefined; }
