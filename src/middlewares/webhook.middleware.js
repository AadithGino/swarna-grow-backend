import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env.js";
import { AppError } from "../lib/app-error.js";
import { incrementWebhookMetric, WebhookMetric } from "../lib/webhook-metrics.js";
import { createRateLimitStore } from "./security.middleware.js";

function skipWebhookRateLimit() {
  return !env.RATE_LIMIT_ENABLED;
}

function webhookProvider(req) {
  if (req.path.includes("/phonepe/")) return "phonepe";
  if (req.path.includes("/whatsapp/")) return "whatsapp";
  return "unknown";
}

export function tenantWebhookKey(req) {
  const ip = ipKeyGenerator(req.ip ?? "127.0.0.1");
  const tenantId = req.params.tenantId ?? "unknown";
  return `${webhookProvider(req)}:${tenantId}:${ip}`;
}

export function assertWebhookBodyWithinLimit(req, _res, next) {
  const raw = req.rawBody ?? req.body;
  const size = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw ?? ""), "utf8");
  if (size > env.WEBHOOK_MAX_BODY_BYTES) {
    incrementWebhookMetric(WebhookMetric.BODY_TOO_LARGE);
    return next(new AppError(
      "WEBHOOK_BODY_TOO_LARGE",
      "Webhook payload exceeds the allowed size.",
      413,
    ));
  }
  return next();
}

export const webhookPerTenantRateLimit = rateLimit({
  windowMs: env.WEBHOOK_RATE_LIMIT_WINDOW_MS ?? 60_000,
  limit: env.WEBHOOK_RATE_LIMIT_PER_TENANT ?? 600,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: skipWebhookRateLimit,
  keyGenerator: tenantWebhookKey,
  store: createRateLimitStore("webhook-tenant"),
  handler: (_req, res) => {
    incrementWebhookMetric(WebhookMetric.RATE_LIMITED);
    res.status(429).json({
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Too many webhook requests. Please retry later.",
      },
    });
  },
});

export const webhookPerIpRateLimit = rateLimit({
  windowMs: env.WEBHOOK_RATE_LIMIT_WINDOW_MS ?? 60_000,
  limit: env.WEBHOOK_RATE_LIMIT_PER_IP ?? 1200,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: skipWebhookRateLimit,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "127.0.0.1"),
  store: createRateLimitStore("webhook-ip"),
  handler: (_req, res) => {
    incrementWebhookMetric(WebhookMetric.RATE_LIMITED);
    res.status(429).json({
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Too many webhook requests. Please retry later.",
      },
    });
  },
});
