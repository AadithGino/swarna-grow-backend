/**
 * Lightweight keep-warm ping so the primary API isolate stays hot.
 * Auth: Authorization Bearer ${CRON_SECRET} (or open when CRON_SECRET unset on Vercel).
 */
import { connectDatabase } from "../../src/config/database.js";
import { connectRedis } from "../../src/config/redis.js";

const g = globalThis;

async function boot() {
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

function authorize(req) {
  // Optional gate: if CRON_SECRET is set, require it; otherwise open on Vercel
  // so an external free cron (Hobby has no sub-daily Vercel crons) can ping.
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return process.env.VERCEL === "1" || process.env.NODE_ENV !== "production";
  const auth = req.headers?.authorization ?? "";
  const q = typeof req.query?.secret === "string" ? req.query.secret : "";
  return auth === `Bearer ${secret}` || auth === secret || q === secret;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method not allowed");
    return;
  }
  if (!authorize(req)) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return;
  }
  try {
    const started = Date.now();
    await boot();
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, ms: Date.now() - started }));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: error?.message || "warm failed" }));
  }
}
