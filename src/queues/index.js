import { Queue } from "bullmq";
import { getRedis, redisReady } from "../config/redis.js";

const queues = new Map();
export function getQueue(name) {
  if (!redisReady()) return null;
  if (!queues.has(name)) queues.set(name, new Queue(name, { connection: getRedis(), prefix: "swarnagrow", defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 } }));
  return queues.get(name);
}
export async function closeQueues() { await Promise.all([...queues.values()].map((queue) => queue.close())); queues.clear(); }
