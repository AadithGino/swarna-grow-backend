/**
 * Lightweight keep-warm ping so the primary API isolate stays hot.
 * Production (VERCEL=1 or NODE_ENV=production): requires CRON_SECRET and
 * Authorization: Bearer <CRON_SECRET>. No query-string or plain-header secrets.
 * Non-production: if CRON_SECRET is unset, allows unauthenticated warm (local dev only).
 */
import { connectDatabase } from "../../src/config/database.js";
import { connectRedis } from "../../src/config/redis.js";
import { assertCronRequestAuthorized, sendCronJson } from "../../src/lib/cron-auth.js";

const g = globalThis;

async function defaultBoot() {
  if (!g.__swarnaWarmBoot) {
    g.__swarnaWarmBoot = Promise.all([
      connectDatabase(),
      connectRedis().catch(() => false),
    ]).catch((err) => {
      g.__swarnaWarmBoot = undefined;
      throw err;
    });
  }
  await g.__swarnaWarmBoot;
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ boot?: () => Promise<void> }} [injected]
 */
export async function keepWarmHttpHandler(req, res, injected) {
  const boot = injected?.boot ?? defaultBoot;
  if (req.method !== "GET" && req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method not allowed");
    return;
  }
  const auth = assertCronRequestAuthorized(req, { requireSecretAlways: false });
  if (!auth.ok) {
    sendCronJson(res, auth.statusCode, auth.body);
    return;
  }
  try {
    const started = Date.now();
    await boot();
    sendCronJson(res, 200, { ok: true, ms: Date.now() - started });
  } catch (error) {
    sendCronJson(res, 500, { ok: false, error: error?.message || "warm failed" });
  }
}

export default async function handler(req, res) {
  return keepWarmHttpHandler(req, res);
}
