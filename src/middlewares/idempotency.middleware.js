import { asyncHandler } from "../lib/async-handler.js";
import { AppError } from "../lib/app-error.js";
import { abandonIdempotency, beginIdempotency, completeIdempotency, renewIdempotencyLease } from "../services/idempotency.service.js";

const activeHeartbeats = new Set();

/** Clears lease heartbeats left open when integration tests end abruptly. */
export function clearIdempotencyHeartbeatsForTests() {
  for (const heartbeat of activeHeartbeats) clearInterval(heartbeat);
  activeHeartbeats.clear();
}

export const idempotent = asyncHandler(async (req, res, next) => {
  const key = req.headers["x-idempotency-key"];
  if (!key) throw new AppError("IDEMPOTENCY_KEY_REQUIRED", "X-Idempotency-Key is required for this request.", 400);
  if (typeof key !== "string" || key.length < 8 || key.length > 128) throw new AppError("IDEMPOTENCY_KEY_INVALID", "X-Idempotency-Key must contain 8 to 128 characters.", 400);
  const context = await beginIdempotency({ tenantId: req.auth?.tenantId ?? req.params.tenantId ?? "public", actorId: req.auth?.id ?? req.ip, endpoint: `${req.method} ${req.route?.path ?? req.path}`, key, body: req.body });
  if (context.replay) { res.setHeader("X-Idempotent-Replay", "true"); return res.status(context.record.responseStatus).json({ ...context.record.responseBody, meta: { ...(context.record.responseBody?.meta ?? {}), idempotentReplay: true } }); }
  req.idempotencyRecord = context.record;
  const heartbeat = globalThis.setInterval(() => void renewIdempotencyLease(context.record), 30_000);
  heartbeat.unref?.();
  activeHeartbeats.add(heartbeat);
  const stopHeartbeat = () => {
    globalThis.clearInterval(heartbeat);
    activeHeartbeats.delete(heartbeat);
  };
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    const statusCode = res.statusCode;
    if (statusCode < 500) {
      const pending = completeIdempotency(context.record, statusCode, body);
      res.locals.idempotencyComplete = pending;
      return pending.then(() => { stopHeartbeat(); return originalJson(body); });
    }
    return originalJson(body);
  };
  res.on("finish", () => {
    stopHeartbeat();
    if (!res.locals.idempotencyComplete && res.statusCode >= 500) {
      void abandonIdempotency(context.record);
    }
  });
  res.on("close", () => {
    stopHeartbeat();
    if (!res.writableEnded && !res.locals.idempotencyComplete) void abandonIdempotency(context.record);
  });
  next();
});
