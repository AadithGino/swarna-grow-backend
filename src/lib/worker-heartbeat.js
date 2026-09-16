import { getRedis, redisReady } from "../config/redis.js";

const HEARTBEAT_KEY = "swarnagrow:ops:worker-heartbeat";
const HEARTBEAT_TTL_SEC = 45;

export async function publishWorkerHeartbeat() {
  await getRedis().set(HEARTBEAT_KEY, new Date().toISOString(), "EX", HEARTBEAT_TTL_SEC);
}

export function startWorkerHeartbeat(intervalMs = 15_000) {
  const tick = () => void publishWorkerHeartbeat().catch(() => {});
  tick();
  return setInterval(tick, intervalMs);
}

export async function workerProcessReady() {
  if (!redisReady()) return false;
  try {
    return Boolean(await getRedis().get(HEARTBEAT_KEY));
  } catch {
    return false;
  }
}
