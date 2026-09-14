import { z } from "zod";

const booleanString = z.string().default("false").transform((value) => value === "true");
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PREFIX: z.string().default("/api/v1"),
  APP_TIMEZONE: z.string().default("Asia/Kolkata"),
  MONGODB_URI: z.string().min(1).default("mongodb://127.0.0.1:27017/swarnagrow?replicaSet=rs0"),
  MONGODB_MAX_POOL_SIZE: z.coerce.number().int().positive().default(50),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  REDIS_REQUIRED: booleanString,
  JWT_ACCESS_SECRET: z.string().min(32).default("development-access-secret-change-me-123456"),
  JWT_REFRESH_SECRET: z.string().min(32).default("development-refresh-secret-change-me-12345"),
  INTEGRATION_ENCRYPTION_KEY: z.string().min(32).default("development-integration-key-change-me"),
  JWT_WEB_TTL: z.string().default("30m"), JWT_MOBILE_TTL: z.string().default("60m"),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().positive().default(30),
  CORS_ORIGINS: z.string().default("http://localhost:3000"), LOG_LEVEL: z.string().default("info"),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1), PROVIDER_MODE: z.enum(["mock", "live"]).default("mock"),
  PHONEPE_BASE_URL: z.string().url().default("https://api-preprod.phonepe.com/apis/pg-sandbox"),
  PHONEPE_MERCHANT_ID: z.string().default(""), PHONEPE_SALT_KEY: z.string().default(""), PHONEPE_SALT_INDEX: z.string().default("1"),
  WHATSAPP_BASE_URL: z.string().default(""), WHATSAPP_ACCESS_TOKEN: z.string().default(""), WHATSAPP_APP_SECRET: z.string().default(""),
  OTP_PROVIDER: z.enum(["mock", "msg91"]).default("mock"), OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  S3_REGION: z.string().default("ap-south-1"), S3_BUCKET: z.string().default(""), S3_ENDPOINT: z.string().default(""),
  S3_ACCESS_KEY_ID: z.string().default(""), S3_SECRET_ACCESS_KEY: z.string().default(""), FCM_PROJECT_ID: z.string().default(""),
  EXPORT_BASE_URL: z.string().url().default("http://localhost:4000"),
  SEED_PLATFORM_MOBILE: z.string().default("+919999999999"), SEED_PLATFORM_PASSWORD: z.string().min(12).default("ChangeMeNow!123"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = Object.freeze({ ...parsed.data, corsOrigins: parsed.data.CORS_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean) });
