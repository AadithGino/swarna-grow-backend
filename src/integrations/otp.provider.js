import { createHash, randomInt } from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { getRedis, redisReady } from "../config/redis.js";
import { AppError } from "../lib/app-error.js";

const memory = new Map();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const RESEND_COOLDOWN_SECONDS = 30;
const MAX_ATTEMPTS = 5;

function otpKey({ tenantId, tenantCode, mobile, purpose }) {
  return `otp:${tenantId ?? tenantCode}:${mobile}:${purpose}`;
}

async function readRecord(key) {
  if (redisReady()) {
    const raw = await getRedis().get(key);
    return raw ? JSON.parse(raw) : null;
  }
  const record = memory.get(key);
  if (!record) return null;
  if (record.expiresAt < Date.now()) { memory.delete(key); return null; }
  return record;
}

async function writeRecord(key, record, ttlSeconds) {
  const payload = { ...record, expiresAt: record.expiresAt ?? Date.now() + ttlSeconds * 1000 };
  if (redisReady()) {
    await getRedis().set(key, JSON.stringify(payload), "EX", ttlSeconds);
    return;
  }
  if (env.NODE_ENV === "production") throw new Error("Redis is required for OTP storage in production.");
  memory.set(key, payload);
}

async function deleteRecord(key) {
  if (redisReady()) await getRedis().del(key);
  else memory.delete(key);
}

export function assertOtpProviderReady(source = env) {
  if (source.PROVIDER_MODE === "live" && source.OTP_PROVIDER !== "mock") {
    throw new Error("Live OTP delivery is not configured. Set PROVIDER_MODE=mock or implement a live OTP_PROVIDER before starting.");
  }
}

function generateOtp() {
  if (env.NODE_ENV === "test") return "123456";
  return String(randomInt(100000, 999999));
}

export const otpProvider = {
  async send({ tenantId, tenantCode, mobile, purpose }) {
    const key = otpKey({ tenantId, tenantCode, mobile, purpose });
    const existing = await readRecord(key);
    if (existing?.sentAt && Date.now() - existing.sentAt < RESEND_COOLDOWN_SECONDS * 1000) {
      throw new AppError("OTP_RESEND_COOLDOWN", `Please wait ${RESEND_COOLDOWN_SECONDS} seconds before requesting another OTP.`, 429);
    }
    const otp = generateOtp();
    const ttl = env.OTP_TTL_SECONDS;
    await writeRecord(key, { hash: hash(otp), attempts: 0, sentAt: Date.now() }, ttl);
    if (env.PROVIDER_MODE === "mock" || env.OTP_PROVIDER === "mock") {
      if (env.NODE_ENV !== "production") logger.info({ tenantId, tenantCode, mobile, purpose, otp }, "Mock OTP queued");
      else logger.info({ tenantId, tenantCode, mobile, purpose }, "Mock OTP queued");
      return { requestId: `otp_${Date.now()}`, expiresIn: ttl };
    }
    throw new Error("MSG91 live adapter requires project-specific template configuration");
  },
  async verify({ tenantId, tenantCode, mobile, purpose, otp }) {
    const key = otpKey({ tenantId, tenantCode, mobile, purpose });
    const record = await readRecord(key);
    if (!record || record.attempts >= MAX_ATTEMPTS) return false;
    record.attempts += 1;
    const ttl = Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000));
    const valid = record.hash === hash(otp);
    if (valid) { await deleteRecord(key); return true; }
    await writeRecord(key, record, ttl);
    return false;
  },
};
