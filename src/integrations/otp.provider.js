import { createHash, randomInt, randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { getRedis, redisReady } from "../config/redis.js";
import { AppError } from "../lib/app-error.js";
import { maskMobile, mobileLookupVariants, canonicalMobile } from "../lib/mobile.js";
import { Customer } from "../models/index.js";
import { sendMsg91Otp } from "./msg91.client.js";

const memory = new Map();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const RESEND_COOLDOWN_SECONDS = 30;
const MAX_ATTEMPTS = 5;

function otpKey({ tenantId, tenantCode, mobile, purpose }) {
  const normalizedMobile = canonicalMobile(mobile);
  return `otp:${tenantId ?? tenantCode}:${normalizedMobile}:${purpose}`;
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
  if (source.PROVIDER_MODE !== "live") return;
  if (source.OTP_PROVIDER === "mock") return;
  if (source.OTP_PROVIDER === "msg91") {
    const missing = ["MSG91_AUTH_KEY", "MSG91_OTP_TEMPLATE_ID", "MSG91_SENDER_ID"]
      .filter((k) => !source[k] || String(source[k]).trim() === "");
    if (missing.length) throw new Error(`MSG91 OTP not configured: missing ${missing.join(", ")}.`);
    return;
  }
  throw new Error(`Unsupported OTP_PROVIDER: ${source.OTP_PROVIDER}`);
}

function generateOtp() {
  if (env.NODE_ENV === "test" || env.NODE_ENV === "development") return "123456";
  return String(randomInt(100000, 999999));
}

async function validateOtp({ tenantId, tenantCode, mobile, purpose, otp, otpId }) {
  const key = otpKey({ tenantId, tenantCode, mobile, purpose });
  const record = await readRecord(key);
  if (!record || record.attempts >= MAX_ATTEMPTS) return false;
  if (otpId && record.otpId && record.otpId !== otpId) return false;
  const otpValue = String(otp ?? "").trim();
  if (record.hash !== hash(otpValue)) {
    record.attempts += 1;
    const ttl = Math.max(1, Math.ceil(((record.expiresAt ?? Date.now()) - Date.now()) / 1000));
    await writeRecord(key, record, ttl);
    return false;
  }
  return true;
}

export const otpProvider = {
  async send({ tenantId, tenantCode, mobile, purpose }, deps = {}) {
    const runtime = deps.env ?? env;
    const key = otpKey({ tenantId, tenantCode, mobile, purpose });
    const existing = await readRecord(key);
    if (existing?.sentAt && Date.now() - existing.sentAt < RESEND_COOLDOWN_SECONDS * 1000) {
      throw new AppError("OTP_RESEND_COOLDOWN", `Please wait ${RESEND_COOLDOWN_SECONDS} seconds before requesting another OTP.`, 429);
    }
    const otp = generateOtp();
    const ttl = env.OTP_TTL_SECONDS;
    const otpId = randomUUID();
    await writeRecord(key, { hash: hash(otp), attempts: 0, sentAt: Date.now(), otpId }, ttl);
    const isRegistered = tenantId
      ? Boolean(
          await Customer.exists({
            tenantId,
            mobile: { $in: mobileLookupVariants(canonicalMobile(mobile)) },
          }),
        )
      : false;
    if (runtime.PROVIDER_MODE === "mock" || runtime.OTP_PROVIDER === "mock") {
      if (env.NODE_ENV !== "production") logger.info({ tenantId, tenantCode, mobile, purpose, otp }, "Mock OTP queued");
      else logger.info({ tenantId, tenantCode, mobile, purpose }, "Mock OTP queued");
      return {
        otpId,
        channel: "SMS",
        maskedMobile: maskMobile(mobile),
        resendAvailableInSeconds: RESEND_COOLDOWN_SECONDS,
        attemptsAllowed: MAX_ATTEMPTS,
        isRegistered,
        expiresInSeconds: ttl,
      };
    }
    try {
      await sendMsg91Otp({ mobile, otp }, { fetch: deps.fetch, env: runtime });
    } catch (err) {
      await deleteRecord(key);
      logger.error({ err: err?.message, tenantId, tenantCode, purpose }, "MSG91 OTP delivery failed");
      throw new AppError("OTP_DELIVERY_FAILED", "Could not send the verification code. Please try again.", 502);
    }
    return {
      otpId,
      channel: "SMS",
      maskedMobile: maskMobile(mobile),
      resendAvailableInSeconds: RESEND_COOLDOWN_SECONDS,
      attemptsAllowed: MAX_ATTEMPTS,
      isRegistered,
      expiresInSeconds: ttl,
    };
  },
  validate: validateOtp,
  async consume({ tenantId, tenantCode, mobile, purpose }) {
    await deleteRecord(otpKey({ tenantId, tenantCode, mobile, purpose }));
  },
  async verify({ tenantId, tenantCode, mobile, purpose, otp, otpId }) {
    const ok = await validateOtp({ tenantId, tenantCode, mobile, purpose, otp, otpId });
    if (!ok) return false;
    await deleteRecord(otpKey({ tenantId, tenantCode, mobile, purpose }));
    return true;
  },
  /** When verify fails, detect OTP issued for the other customer auth purpose (LOGIN vs SIGNUP). */
  async findMatchingPurpose({ tenantId, tenantCode, mobile, purpose, otpId }) {
    if (!otpId) return null;
    for (const alt of ["LOGIN", "SIGNUP"]) {
      if (alt === purpose) continue;
      const record = await readRecord(otpKey({ tenantId, tenantCode, mobile, purpose: alt }));
      if (record?.otpId === otpId) return alt;
    }
    return null;
  },
};
