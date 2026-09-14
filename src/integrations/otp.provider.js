import { createHash, randomInt } from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const memory = new Map();
const hash = (value) => createHash("sha256").update(value).digest("hex");
export const otpProvider = {
  async send({ tenantCode, mobile, purpose }) {
    const otp = env.NODE_ENV === "production" ? String(randomInt(100000, 999999)) : "123456";
    const key = `${tenantCode}:${mobile}:${purpose}`;
    memory.set(key, { hash: hash(otp), expiresAt: Date.now() + env.OTP_TTL_SECONDS * 1000, attempts: 0 });
    if (env.PROVIDER_MODE === "mock" || env.OTP_PROVIDER === "mock") { logger.info({ tenantCode, mobile, purpose, developmentOtp: env.NODE_ENV === "production" ? undefined : otp }, "Mock OTP queued"); return { requestId: `otp_${Date.now()}`, expiresIn: env.OTP_TTL_SECONDS }; }
    throw new Error("MSG91 live adapter requires project-specific template configuration");
  },
  async verify({ tenantCode, mobile, purpose, otp }) {
    const key = `${tenantCode}:${mobile}:${purpose}`; const record = memory.get(key);
    if (!record || record.expiresAt < Date.now() || record.attempts >= 5) return false;
    record.attempts += 1; const valid = record.hash === hash(otp); if (valid) memory.delete(key); return valid;
  },
};
