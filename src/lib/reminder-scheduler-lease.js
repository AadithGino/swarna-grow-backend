import { env } from "../config/env.js";
import { getRedis, redisReady } from "../config/redis.js";
import { randomToken } from "./crypto.js";

function leaseMs() {
  return env.REMINDER_SCHEDULER_LEASE_MS ?? 300_000;
}

export function reminderLeaseKey({ tenantId, today, windowKey }) {
  return `swarnagrow:reminder:lease:${tenantId}:${today}:${windowKey}`;
}

/** @returns {Promise<string|null>} lease token when acquired */
export async function acquireReminderSchedulerLease({ tenantId, today, windowKey }) {
  if (!redisReady()) return randomToken(8);
  const key = reminderLeaseKey({ tenantId, today, windowKey });
  const token = randomToken(12);
  const result = await getRedis().set(key, token, "PX", leaseMs(), "NX");
  return result === "OK" ? token : null;
}

export async function releaseReminderSchedulerLease({ tenantId, today, windowKey, token }) {
  if (!redisReady() || !token) return;
  const key = reminderLeaseKey({ tenantId, today, windowKey });
  const script = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    end
    return 0
  `;
  await getRedis().eval(script, 1, key, token);
}

/** @returns {Promise<boolean>} true when lease was renewed (or redis optional in test) */
export async function refreshReminderSchedulerLease({ tenantId, today, windowKey, token }) {
  if (!redisReady() || !token) return true;
  const key = reminderLeaseKey({ tenantId, today, windowKey });
  const script = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("PEXPIRE", KEYS[1], ARGV[2])
    end
    return 0
  `;
  const result = await getRedis().eval(script, 1, key, token, String(leaseMs()));
  return result === 1;
}
