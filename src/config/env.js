import { z } from "zod";

const booleanString = z.string().default("false").transform((value) => value === "true");
const csvString = z.string().default("").transform((value) =>
  value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
);
const upiFlowsString = z.string().default("INTENT").transform((value) => {
  const allowed = new Set(["INTENT", "COLLECT", "QR"]);
  const parsed = value
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter((item) => allowed.has(item));
  return parsed.length ? parsed : ["INTENT"];
});

const boundedInt = (min, max, fallback) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

export function fcmEnvConfigured(source) {
  const projectId = String(source.FCM_PROJECT_ID ?? "").trim();
  const raw = String(source.FCM_SERVICE_ACCOUNT_JSON ?? "").trim();
  if (!projectId || !raw) return false;
  try {
    const parsed = JSON.parse(raw);
    return Boolean(parsed?.client_email && parsed?.private_key);
  } catch {
    return false;
  }
}

export const SECRET_DEFAULTS = Object.freeze({
  JWT_ACCESS_SECRET: "REPLACE_ME_JWT_ACCESS_SECRET_DO_NOT_SHIP",
  JWT_REFRESH_SECRET: "REPLACE_ME_JWT_REFRESH_SECRET_DO_NOT_SHIP",
  INTEGRATION_ENCRYPTION_KEY: "REPLACE_ME_INTEGRATION_ENCRYPTION_KEY!!",
  SEED_PLATFORM_PASSWORD: "REPLACE_ME_SEED_PLATFORM_PASSWORD",
});

const REQUIRED_PRODUCTION_SECRETS = Object.keys(SECRET_DEFAULTS);

export function parseEnv(source = process.env) {
  return z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    API_PREFIX: z.string().default("/api/v1"),
    APP_TIMEZONE: z.string().default("Asia/Kolkata"),
    MONGODB_URI: z.string().min(1).default("mongodb://127.0.0.1:27017/swarnagrow?replicaSet=rs0"),
    MONGODB_MAX_POOL_SIZE: z.coerce.number().int().positive().default(50),
    REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
    REDIS_REQUIRED: booleanString,
    RATE_LIMIT_ENABLED: z.string().default("true").transform((value) => value === "true"),
    JWT_ACCESS_SECRET: z.string().min(32).default(SECRET_DEFAULTS.JWT_ACCESS_SECRET),
    JWT_REFRESH_SECRET: z.string().min(32).default(SECRET_DEFAULTS.JWT_REFRESH_SECRET),
    INTEGRATION_ENCRYPTION_KEY: z.string().min(32).default(SECRET_DEFAULTS.INTEGRATION_ENCRYPTION_KEY),
    JWT_WEB_TTL: z.string().default("30m"), JWT_MOBILE_TTL: z.string().default("60m"),
    REFRESH_TOKEN_DAYS: z.coerce.number().int().positive().default(365),
    CORS_ORIGINS: z.string().default("http://localhost:3000,http://localhost:5173,http://localhost:5174"), LOG_LEVEL: z.string().default("info"),
    TRUST_PROXY: z.coerce.number().int().min(0).default(1), PROVIDER_MODE: z.enum(["mock", "live"]).default("mock"),
    PHONEPE_ENV: z.enum(["SANDBOX", "PRODUCTION"]).default("SANDBOX"),
    PHONEPE_UPI_INTENT_ONLY: booleanString,
    PHONEPE_UPI_APPS: csvString,
    PHONEPE_UPI_FLOWS: upiFlowsString,
    WHATSAPP_BASE_URL: z.string().default(""), WHATSAPP_ACCESS_TOKEN: z.string().default(""), WHATSAPP_APP_SECRET: z.string().default(""),
    OTP_PROVIDER: z.enum(["mock", "msg91"]).default("mock"), OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    S3_REGION: z.string().default("ap-south-1"), S3_BUCKET: z.string().default(""), S3_ENDPOINT: z.string().default(""),
    S3_ACCESS_KEY_ID: z.string().default(""), S3_SECRET_ACCESS_KEY: z.string().default(""),     FCM_PROJECT_ID: z.string().default(""),
    FCM_SERVICE_ACCOUNT_JSON: z.string().default(""),
    FCM_SHARED_PROJECT_ENABLED: booleanString,
    FCM_SEND_CONCURRENCY: z.coerce.number().int().positive().default(32),
    FCM_MULTICAST_BATCH_SIZE: boundedInt(1, 500, 500),
    FCM_RATE_LIMIT_GLOBAL_PER_SEC: boundedInt(1, 10_000, 200),
    FCM_RATE_LIMIT_GLOBAL_BURST: boundedInt(1, 50_000, 400),
    FCM_RATE_LIMIT_TENANT_PER_SEC: boundedInt(1, 10_000, 80),
    FCM_RATE_LIMIT_TENANT_BURST: boundedInt(1, 50_000, 160),
    FCM_RATE_LIMIT_KEY_TTL_SEC: boundedInt(60, 86_400, 3600),
    FCM_RATE_LIMIT_REDIS_UNAVAILABLE_MS: boundedInt(500, 300_000, 5000),
    FCM_DELIVERY_CLAIM_MS: boundedInt(10_000, 600_000, 120_000),
    FCM_REQUEST_TIMEOUT_MS: boundedInt(1_000, 120_000, 15_000),
    FCM_MAX_ATTEMPTS: boundedInt(1, 10, 3),
    FCM_RETRY_BASE_MS: boundedInt(100, 60_000, 500),
    FCM_MAX_DEVICES_PER_PRINCIPAL: boundedInt(1, 50, 10),
    PHONEPE_REQUEST_TIMEOUT_MS: boundedInt(1_000, 120_000, 20_000),
    PHONEPE_RECONCILE_BATCH_SIZE: boundedInt(1, 500, 50),
    PHONEPE_RECONCILE_STALE_SECONDS: boundedInt(60, 86_400, 900),
    PHONEPE_RECONCILE_MAX_ATTEMPTS: boundedInt(1, 20, 5),
    PHONEPE_RECONCILE_LEASE_MS: boundedInt(10_000, 600_000, 120_000),
    WEBHOOK_MAX_BODY_BYTES: boundedInt(1_024, 10_485_760, 2_097_152),
    WEBHOOK_RATE_LIMIT_WINDOW_MS: boundedInt(1_000, 900_000, 60_000),
    WEBHOOK_RATE_LIMIT_PER_TENANT: boundedInt(10, 50_000, 600),
    WEBHOOK_RATE_LIMIT_PER_IP: boundedInt(10, 100_000, 1200),
    WEBHOOK_PROCESSING_LEASE_MS: boundedInt(30_000, 900_000, 300_000),
    WEBHOOK_SIGNATURE_FAILURE_RETENTION_SEC: boundedInt(3_600, 2_592_000, 86_400),
    WEBHOOK_RAW_RETENTION_SEC: boundedInt(3_600, 2_592_000, 604_800),
    WEBHOOK_COMPLETED_RETENTION_SEC: boundedInt(86_400, 31_536_000, 2_592_000),
    MESSAGE_DISPATCH_BATCH_SIZE: z.coerce.number().int().positive().default(250),
    MESSAGE_DISPATCH_TENANT_BATCH_SIZE: boundedInt(1, 500, 50),
    MESSAGE_DISPATCH_TENANT_PAGE_SIZE: boundedInt(1, 256, 32),
    MESSAGE_DISPATCH_TENANT_QUERY_CONCURRENCY: boundedInt(1, 16, 4),
    SCHEDULER_REQUIRE_WORKER_ROLES: booleanString,
    MESSAGE_DISPATCH_STALE_MS: boundedInt(60_000, 3_600_000, 900_000),
    MESSAGE_DISPATCH_LEASE_MS: boundedInt(5_000, 600_000, 120_000),
    MESSAGE_DISPATCH_DISPATCHED_STALE_MS: boundedInt(60_000, 3_600_000, 900_000),
    DISPATCH_RECLAIM_BATCH_SIZE: boundedInt(10, 2000, 200),
    LEGACY_MESSAGE_SEND_OUTBOX_BATCH_SIZE: boundedInt(10, 2000, 200),
    SCHEME_MAINTENANCE_BATCH_SIZE: boundedInt(10, 2000, 200),
    SCHEME_MAINTENANCE_MAX_BATCHES_PER_RUN: boundedInt(1, 500, 50),
    REMINDER_SCHEDULER_MAX_TENANT_BATCHES_PER_RUN: boundedInt(1, 500, 20),
    MESSAGE_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(40),
    PUSH_BROADCAST_CHUNK_SIZE: z.coerce.number().int().positive().default(400),
    PUSH_BROADCAST_LEASE_MS: boundedInt(10_000, 600_000, 120_000),
    PUSH_BROADCAST_MAX_CHUNK_ATTEMPTS: boundedInt(1, 50, 12),
    FCM_DEFAULT_TTL_SEC: boundedInt(60, 604_800, 86_400),
    REMINDER_SCHEME_BATCH_SIZE: boundedInt(10, 500, 100),
    REMINDER_TENANT_BATCH_SIZE: boundedInt(1, 200, 50),
    REMINDER_SCHEDULER_LEASE_MS: boundedInt(30_000, 900_000, 300_000),
    REMINDER_MAX_SCHEME_BATCHES_PER_TENANT_PER_RUN: boundedInt(1, 500, 5),
    REMINDER_MAX_SCHEMES_PER_TENANT_PER_RUN: boundedInt(10, 50_000, 500),
    PAYMENT_EXPIRY_BATCH_SIZE: boundedInt(10, 1000, 100),
    PAYMENT_EXPIRY_MAX_BATCHES_PER_RUN: boundedInt(1, 500, 20),
    MAINTENANCE_CURSOR_TTL_SEC: boundedInt(3_600, 2_592_000, 604_800),
    MAINTENANCE_SCAN_LEASE_MS: boundedInt(5_000, 900_000, 120_000),
    SCHEDULER_JOB_ATTEMPTS: boundedInt(1, 20, 3),
    SCHEDULER_JOB_BACKOFF_MS: boundedInt(1_000, 600_000, 30_000),
    PAYMENTS_JOB_ATTEMPTS: boundedInt(1, 20, 5),
    PAYMENTS_JOB_BACKOFF_MS: boundedInt(1_000, 600_000, 15_000),
    MAINTENANCE_JOB_ATTEMPTS: boundedInt(1, 20, 5),
    MAINTENANCE_JOB_BACKOFF_MS: boundedInt(1_000, 600_000, 15_000),
    WEBHOOK_RECLAIM_BATCH_SIZE: boundedInt(10, 2000, 100),
    WEBHOOK_RECLAIM_MAX_BATCHES_PER_RUN: boundedInt(1, 500, 10),
    /** Optional platform safety cap; 0 = no cap (use tenant plan limit only). */
    PUSH_BROADCAST_MAX_RECIPIENTS: z.coerce.number().int().min(0).default(0),
    REPORT_MAX_SYNC_ROWS: boundedInt(100, 100_000, 5_000),
    REPORT_EXPORT_MAX_ROWS: boundedInt(1_000, 2_000_000, 200_000),
    REPORT_EXPORT_MAX_BYTES: boundedInt(64_000, 524_288_000, 52_428_800),
    REPORT_EXPORT_MAX_RUNTIME_MS: boundedInt(30_000, 3_600_000, 600_000),
    REPORT_EXPORT_MAX_CONCURRENT_PER_TENANT: boundedInt(1, 20, 3),
    REPORT_EXPORT_DOWNLOAD_TTL_MS: boundedInt(60_000, 86_400_000, 900_000),
    REPORT_EXPORT_ARTIFACT_RETENTION_MS: boundedInt(86_400_000, 2_592_000_000, 604_800_000),
    READINESS_MESSAGE_QUEUE_LAG_MS: boundedInt(60_000, 3_600_000, 300_000),
    READINESS_WEBHOOK_QUEUE_WAITING_MAX: boundedInt(10, 50_000, 500),
    READINESS_WEBHOOK_EVENT_BACKLOG_MAX: boundedInt(10, 100_000, 1_000),
    READINESS_WEBHOOK_DEAD_LETTER_MAX: boundedInt(0, 10_000, 50),
    MALWARE_SCAN_URL: z.string().url().optional(), MALWARE_SCAN_API_KEY: z.string().default(""),
    EXPORT_BASE_URL: z.string().url().default("http://localhost:4000"),
    PUBLIC_BASE_URL: z.string().url().default("http://localhost:4000"),
    SEED_PLATFORM_MOBILE: z.string().default("+919999999999"),
    SEED_PLATFORM_EMAIL: z.string().email().default("ops@platform.com"),
    SEED_PLATFORM_PASSWORD: z.string().min(4).max(128).default("1234"),
  }).superRefine((_value, context) => {
    const nodeEnv = source.NODE_ENV ?? "development";
    if (nodeEnv !== "production") return;
    const offending = [];
    for (const key of REQUIRED_PRODUCTION_SECRETS) {
      const raw = source[key];
      if (raw == null || String(raw).trim() === "" || raw === SECRET_DEFAULTS[key]) offending.push(key);
    }
    const redisRequired = source.REDIS_REQUIRED ?? "false";
    if (redisRequired !== "true") offending.push("REDIS_REQUIRED");
    const rateLimitEnabled = source.RATE_LIMIT_ENABLED ?? "true";
    if (rateLimitEnabled !== "true") offending.push("RATE_LIMIT_ENABLED");
    const providerMode = source.PROVIDER_MODE ?? "mock";
    if (providerMode !== "live") offending.push("PROVIDER_MODE");
    const otpProvider = source.OTP_PROVIDER ?? "mock";
    if (otpProvider === "mock") offending.push("OTP_PROVIDER");
    const phonePeEnv = source.PHONEPE_ENV ?? "SANDBOX";
    if (phonePeEnv !== "PRODUCTION") offending.push("PHONEPE_ENV");
    const sharedFcm = source.FCM_SHARED_PROJECT_ENABLED ?? "false";
    if (sharedFcm === "true" && !fcmEnvConfigured(source)) {
      offending.push("FCM_PROJECT_ID", "FCM_SERVICE_ACCOUNT_JSON");
    }
    for (const key of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
      const raw = source[key];
      if (raw == null || String(raw).trim() === "") offending.push(key);
    }
    if (!source.MALWARE_SCAN_URL) offending.push("MALWARE_SCAN_URL");
    const corsOrigins = source.CORS_ORIGINS ?? "http://localhost:3000,http://localhost:5173,http://localhost:5174";
    if (corsOrigins === "http://localhost:3000,http://localhost:5173,http://localhost:5174") offending.push("CORS_ORIGINS");
    for (const key of ["PUBLIC_BASE_URL", "EXPORT_BASE_URL"]) {
      const raw = source[key];
      try {
        const url = new URL(raw);
        if (url.protocol !== "https:" || ["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname)) offending.push(key);
      } catch {
        offending.push(key);
      }
    }
    if (offending.length) {
      context.addIssue({
        code: "custom",
        message: `Production environment misconfiguration: ${offending.join(", ")}`,
        path: offending,
      });
    }
  }).safeParse(source);
}

const parsed = parseEnv(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration", parsed.error.flatten().fieldErrors, parsed.error.issues.map((issue) => issue.message));
  process.exit(1);
}

export const env = Object.freeze({ ...parsed.data, corsOrigins: parsed.data.CORS_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean) });
