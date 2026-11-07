/**
 * Vercel Cron fallback: run queue-equivalent maintenance inline (no BullMQ worker process).
 * Requires nonempty CRON_SECRET and Authorization: Bearer <CRON_SECRET> in every environment.
 * Query-string secrets are not accepted.
 */
import { connectDatabase } from "../../src/config/database.js";
import { connectRedis } from "../../src/config/redis.js";
import { assertCronRequestAuthorized, sendCronJson } from "../../src/lib/cron-auth.js";
import { tryAcquireCronQueueTickLock, releaseCronQueueTickLock } from "../../src/lib/cron-overlap-lock.js";
import { runDispatchCycle } from "../../src/services/dispatch.service.js";
import { runDigitalMetalOutboxDispatch } from "../../src/services/digital-metals-outbox-dispatch.service.js";
import { runDispatchLeaseReclamation } from "../../src/services/dispatch-reclaim.service.js";

let booted;

async function defaultBoot() {
  if (booted) return;
  await connectDatabase();
  await connectRedis().catch(() => false);
  booted = true;
}

/**
 * @typedef {{ boot?: () => Promise<void>; runDispatchCycle?: () => Promise<unknown>; runDigitalMetalOutboxDispatch?: (d: Date) => Promise<unknown>; runDispatchLeaseReclamation?: () => Promise<unknown>; tryAcquireCronQueueTickLock?: () => Promise<boolean>; releaseCronQueueTickLock?: () => Promise<void> }} QueueTickInjected
 */

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {QueueTickInjected} [injected]
 */
export async function queueTickHttpHandler(req, res, injected) {
  const boot = injected?.boot ?? defaultBoot;
  const dispatch = injected?.runDispatchCycle ?? runDispatchCycle;
  const dmOutbox = injected?.runDigitalMetalOutboxDispatch ?? runDigitalMetalOutboxDispatch;
  const reclaim = injected?.runDispatchLeaseReclamation ?? runDispatchLeaseReclamation;
  const acquireLock = injected?.tryAcquireCronQueueTickLock ?? tryAcquireCronQueueTickLock;
  const releaseLock = injected?.releaseCronQueueTickLock ?? releaseCronQueueTickLock;

  if (req.method !== "GET" && req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method not allowed");
    return;
  }
  const auth = assertCronRequestAuthorized(req, { requireSecretAlways: true });
  if (!auth.ok) {
    sendCronJson(res, auth.statusCode, auth.body);
    return;
  }
  let lockHeld = false;
  try {
    await boot();
    lockHeld = await acquireLock();
    if (!lockHeld) {
      sendCronJson(res, 200, {
        ok: true,
        skipped: true,
        reason: "concurrent_tick",
        at: new Date().toISOString(),
      });
      return;
    }
    const now = new Date();
    const [dispatchR, dmOutboxR, reclaimR] = await Promise.all([
      dispatch().catch((err) => ({ error: String(err?.message ?? err) })),
      dmOutbox(now).catch((err) => ({ error: String(err?.message ?? err) })),
      reclaim().catch((err) => ({ error: String(err?.message ?? err) })),
    ]);
    const parts = { dispatch: dispatchR, dmOutbox: dmOutboxR, reclaim: reclaimR };
    const hasError = Object.values(parts).some(
      (p) => p && typeof p === "object" && "error" in p,
    );
    sendCronJson(res, hasError ? 500 : 200, {
      ok: !hasError,
      at: now.toISOString(),
      health: hasError ? "degraded" : "ok",
      ...parts,
    });
  } catch (err) {
    sendCronJson(res, 500, { ok: false, error: String(err?.message ?? err) });
  } finally {
    if (lockHeld) await releaseLock();
  }
}

export default async function handler(req, res) {
  return queueTickHttpHandler(req, res);
}
