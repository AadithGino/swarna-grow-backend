/**
 * Vercel Cron fallback: run queue-equivalent maintenance inline (no BullMQ worker process).
 * Full message/webhook workers still need `npm run worker` on Render/Railway + Upstash Redis.
 */
import { connectDatabase } from "../../src/config/database.js";
import { connectRedis } from "../../src/config/redis.js";
import { runDispatchCycle } from "../../src/services/dispatch.service.js";
import { runDigitalMetalOutboxDispatch } from "../../src/services/digital-metals-outbox-dispatch.service.js";
import { runDispatchLeaseReclamation } from "../../src/services/dispatch-reclaim.service.js";

let booted;

async function boot() {
  if (booted) return;
  await connectDatabase();
  await connectRedis().catch(() => false);
  booted = true;
}

function authorize(req) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return process.env.VERCEL === "1";
  const auth = req.headers?.authorization ?? "";
  if (auth === `Bearer ${secret}`) return true;
  return auth === secret;
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
    await boot();
    const now = new Date();
    const [dispatch, dmOutbox, reclaim] = await Promise.all([
      runDispatchCycle().catch((err) => ({ error: String(err?.message ?? err) })),
      runDigitalMetalOutboxDispatch(now).catch((err) => ({ error: String(err?.message ?? err) })),
      runDispatchLeaseReclamation().catch((err) => ({ error: String(err?.message ?? err) })),
    ]);
    res.setHeader("content-type", "application/json");
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, at: now.toISOString(), dispatch, dmOutbox, reclaim }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
  }
}
