import { asyncHandler } from "../lib/async-handler.js";
import { AppError } from "../lib/app-error.js";
import { abandonIdempotency, beginIdempotency, completeIdempotency } from "../services/idempotency.service.js";

export const idempotent = asyncHandler(async (req, res, next) => {
  const key = req.headers["x-idempotency-key"];
  if (!key) throw new AppError("IDEMPOTENCY_KEY_REQUIRED", "X-Idempotency-Key is required for this request.", 400);
  if (typeof key !== "string" || key.length < 8 || key.length > 128) throw new AppError("IDEMPOTENCY_KEY_INVALID", "X-Idempotency-Key must contain 8 to 128 characters.", 400);
  const context = await beginIdempotency({ tenantId: req.auth?.tenantId ?? req.params.tenantId ?? "public", actorId: req.auth?.id ?? req.ip, endpoint: `${req.method} ${req.route?.path ?? req.path}`, key, body: req.body });
  if (context.replay) { res.setHeader("X-Idempotent-Replay", "true"); return res.status(context.record.responseStatus).json({ ...context.record.responseBody, meta: { ...(context.record.responseBody?.meta ?? {}), idempotentReplay: true } }); }
  req.idempotencyRecord = context.record;
  const originalJson = res.json.bind(res);
  res.json = (body) => { if (res.statusCode < 500) void completeIdempotency(context.record, res.statusCode, body); return originalJson(body); };
  res.on("close", () => { if (!res.writableEnded) void abandonIdempotency(context.record); });
  next();
});
