import { env } from "../config/env.js";
import { getQueue } from "../queues/index.js";
import { redisReady } from "../config/redis.js";
import { Message, WebhookEvent } from "../models/index.js";
import { JobStatus } from "../constants/enums.js";

const MONITORED_QUEUES = ["messages", "webhooks", "outbox", "exports", "scheduler", "payments", "maintenance"];

export async function getQueueHealthSnapshot() {
  if (!redisReady()) {
    return { available: false, queues: {}, oldestMessageQueuedMs: null, webhookBacklog: null };
  }

  const queues = {};
  for (const name of MONITORED_QUEUES) {
    const queue = getQueue(name);
    if (!queue) continue;
    try {
      queues[name] = await queue.getJobCounts("waiting", "active", "delayed", "failed", "paused");
    } catch {
      queues[name] = { error: "unavailable" };
    }
  }

  const oldestMessage = await Message.findOne({ status: "QUEUED" })
    .sort({ createdAt: 1 })
    .select("createdAt")
    .lean();
  const oldestMessageQueuedMs = oldestMessage?.createdAt
    ? Math.max(0, Date.now() - new Date(oldestMessage.createdAt).getTime())
    : 0;

  const [webhookQueued, webhookProcessing, webhookDeadLetter] = await Promise.all([
    WebhookEvent.countDocuments({ status: JobStatus.QUEUED }),
    WebhookEvent.countDocuments({ status: JobStatus.PROCESSING }),
    WebhookEvent.countDocuments({ status: JobStatus.DEAD_LETTER }),
  ]);

  return {
    available: true,
    queues,
    oldestMessageQueuedMs,
    webhookBacklog: {
      queued: webhookQueued,
      processing: webhookProcessing,
      deadLetter: webhookDeadLetter,
    },
  };
}

export function evaluateQueueHealth(snapshot) {
  const warnings = [];
  if (!snapshot?.available) {
    warnings.push("QUEUE_METRICS_UNAVAILABLE");
    return { healthy: false, warnings };
  }

  const messageLagMs = snapshot.oldestMessageQueuedMs ?? 0;
  const messageLagLimit = env.READINESS_MESSAGE_QUEUE_LAG_MS ?? 300_000;
  if (messageLagMs > messageLagLimit) {
    warnings.push("MESSAGE_QUEUE_LAG");
  }

  const webhookWaiting = snapshot.queues.webhooks?.waiting ?? 0;
  const webhookWaitingLimit = env.READINESS_WEBHOOK_QUEUE_WAITING_MAX ?? 500;
  if (webhookWaiting > webhookWaitingLimit) {
    warnings.push("WEBHOOK_BULLMQ_DEPTH");
  }

  const webhookQueued = snapshot.webhookBacklog?.queued ?? 0;
  const webhookQueuedLimit = env.READINESS_WEBHOOK_EVENT_BACKLOG_MAX ?? 1_000;
  if (webhookQueued > webhookQueuedLimit) {
    warnings.push("WEBHOOK_EVENT_BACKLOG");
  }

  const deadLetter = snapshot.webhookBacklog?.deadLetter ?? 0;
  const deadLetterLimit = env.READINESS_WEBHOOK_DEAD_LETTER_MAX ?? 50;
  if (deadLetter > deadLetterLimit) {
    warnings.push("WEBHOOK_DEAD_LETTER");
  }

  return { healthy: warnings.length === 0, warnings };
}
