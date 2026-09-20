import { getRedis, redisReady } from "../config/redis.js";

const CURSOR_TTL_SEC = 86_400;

export function reminderStreamCursorKey({ tenantId, dayYmd, windowKey, stream }) {
  return `swarnagrow:reminder:cursor:${tenantId}:${dayYmd}:${windowKey}:${stream}`;
}

export async function readReminderStreamCursor(keyParts) {
  if (!redisReady()) return null;
  const value = await getRedis().get(reminderStreamCursorKey(keyParts));
  return value || null;
}

export async function writeReminderStreamCursor(keyParts, schemeId) {
  if (!redisReady() || !schemeId) return;
  await getRedis().set(reminderStreamCursorKey(keyParts), schemeId, "EX", CURSOR_TTL_SEC);
}

export async function clearReminderStreamCursor(keyParts) {
  if (!redisReady()) return;
  await getRedis().del(reminderStreamCursorKey(keyParts));
}

export const ReminderStream = Object.freeze({
  FIXED: "FIXED",
  FLEX_NUDGE: "FLEX_NUDGE",
  MATURITY: "MATURITY",
  FLEX_LOCK: "FLEX_LOCK",
});
