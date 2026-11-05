import { createHash, randomInt, randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { getRedis, redisReady } from "../config/redis.js";
import { AppError } from "../lib/app-error.js";
import {
  getMessageCentralAuthToken,
  loadPlatformMessageCentralCredentials,
  loadTenantMessageCentralCredentials,
  messageCentralConfiguredForOtp,
} from "../lib/message-central-credentials.js";
import { maskMobile, mobileLookupVariants, canonicalMobile } from "../lib/mobile.js";
import { Customer } from "../models/index.js";
import { sendMessageCentralOtp, validateMessageCentralOtp } from "./message-central.client.js";
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
  if (source.OTP_PROVIDER === "message_central") return;
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

async function resolveDeliveryPlan({ tenantId, runtime }, deps = {}) {
  if (tenantId) {
    const credentials = deps.messageCentralCredentials
      ?? await loadTenantMessageCentralCredentials(tenantId);
    if (messageCentralConfiguredForOtp(credentials)) {
      return { channel: "message_central", tenantId, credentials };
    }
    if (runtime.OTP_PROVIDER === "message_central") {
      throw new AppError(
        "OTP_NOT_CONFIGURED",
        "SMS verification is not configured for this tenant yet.",
        503,
      );
    }
  } else if (runtime.OTP_PROVIDER === "message_central") {
    const platformCredentials = deps.platformMessageCentralCredentials
      ?? loadPlatformMessageCentralCredentials(runtime);
    if (messageCentralConfiguredForOtp(platformCredentials)) {
      return { channel: "message_central", tenantId: null, credentials: platformCredentials };
    }
    throw new AppError(
      "OTP_NOT_CONFIGURED",
      "SMS verification is not configured for merchant signup yet.",
      503,
    );
  }
  if (runtime.PROVIDER_MODE === "mock" || runtime.OTP_PROVIDER === "mock") {
    return { channel: "mock" };
  }
  if (runtime.OTP_PROVIDER === "msg91") {
    return { channel: "msg91" };
  }
  return { channel: "mock" };
}

async function validateOtpLocal({ tenantId, tenantCode, mobile, purpose, otp, otpId }) {
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

async function validateOtpMessageCentral(
  { tenantId, tenantCode, mobile, purpose, otp, otpId },
  deps = {},
) {
  const key = otpKey({ tenantId, tenantCode, mobile, purpose });
  const record = await readRecord(key);
  if (!record || record.provider !== "message_central" || record.attempts >= MAX_ATTEMPTS) {
    return false;
  }
  if (otpId && record.otpId && record.otpId !== otpId) return false;
  const credentials = deps.messageCentralCredentials
    ?? (tenantId
      ? await loadTenantMessageCentralCredentials(tenantId)
      : loadPlatformMessageCentralCredentials(deps.env ?? env));
  if (!credentials) return false;
  const expectedLength = Number(record.otpLength ?? credentials.otpLength ?? 6);
  if (!new RegExp(`^\\d{${expectedLength}}$`).test(String(otp ?? "").trim())) {
    record.attempts += 1;
    const ttl = Math.max(1, Math.ceil(((record.expiresAt ?? Date.now()) - Date.now()) / 1000));
    await writeRecord(key, record, ttl);
    return false;
  }
  try {
    const authToken = await getMessageCentralAuthToken(
      credentials,
      tenantId ?? "platform",
      deps,
    );
    const result = await validateMessageCentralOtp(
      { authToken, verificationId: record.verificationId, code: otp },
      deps,
    );
    if (!result.ok) {
      record.attempts += 1;
      const ttl = Math.max(1, Math.ceil(((record.expiresAt ?? Date.now()) - Date.now()) / 1000));
      await writeRecord(key, record, ttl);
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err: err?.message, tenantId, purpose }, "Message Central OTP validate failed");
    return false;
  }
}

async function validateOtp(params, deps = {}) {
  const key = otpKey(params);
  const record = await readRecord(key);
  if (record?.provider === "message_central") {
    return validateOtpMessageCentral(params, deps);
  }
  return validateOtpLocal(params);
}

export const otpProvider = {
  async send({ tenantId, tenantCode, mobile, purpose }, deps = {}) {
    const runtime = deps.env ?? env;
    const key = otpKey({ tenantId, tenantCode, mobile, purpose });
    const existing = await readRecord(key);
    if (existing?.sentAt && Date.now() - existing.sentAt < RESEND_COOLDOWN_SECONDS * 1000) {
      throw new AppError("OTP_RESEND_COOLDOWN", `Please wait ${RESEND_COOLDOWN_SECONDS} seconds before requesting another OTP.`, 429);
    }
    const plan = await resolveDeliveryPlan({ tenantId, runtime }, deps);
    const ttl = env.OTP_TTL_SECONDS;
    const otpId = randomUUID();
    const isRegistered = tenantId
      ? Boolean(
          await Customer.exists({
            tenantId,
            mobile: { $in: mobileLookupVariants(canonicalMobile(mobile)) },
          }),
        )
      : false;

    if (plan.channel === "mock") {
      const otp = generateOtp();
      await writeRecord(key, { hash: hash(otp), attempts: 0, sentAt: Date.now(), otpId }, ttl);
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

    if (plan.channel === "message_central") {
      const { credentials } = plan;
      try {
        const authToken = await getMessageCentralAuthToken(
          credentials,
          tenantId ?? "platform",
          deps,
        );
        const sent = await sendMessageCentralOtp(
          {
            authToken,
            mobile,
            countryCode: credentials.countryCode,
            flowType: credentials.flowType,
            otpLength: credentials.otpLength,
          },
          deps,
        );
        await writeRecord(key, {
          provider: "message_central",
          verificationId: sent.verificationId,
          otpLength: Number(credentials.otpLength ?? 6),
          attempts: 0,
          sentAt: Date.now(),
          otpId,
        }, ttl);
      } catch (err) {
        const mcMessage = String(err?.message ?? "");
        if (mcMessage.includes("REQUEST_ALREADY_EXISTS")) {
          if (
            existing?.provider === "message_central"
            && existing.verificationId
          ) {
            const reuseOtpId = existing.otpId ?? otpId;
            await writeRecord(
              key,
              { ...existing, sentAt: Date.now(), otpId: reuseOtpId },
              ttl,
            );
            logger.info(
              { tenantId, tenantCode, purpose },
              "Message Central OTP already active — reusing local verification session",
            );
            return {
              otpId: reuseOtpId,
              channel: "SMS",
              maskedMobile: maskMobile(mobile),
              resendAvailableInSeconds: RESEND_COOLDOWN_SECONDS,
              attemptsAllowed: MAX_ATTEMPTS,
              isRegistered,
              expiresInSeconds: ttl,
            };
          }
          throw new AppError(
            "OTP_RESEND_COOLDOWN",
            "An OTP was already sent to this mobile. Check your messages or wait a few minutes before requesting again.",
            429,
          );
        }
        await deleteRecord(key);
        logger.error({ err: mcMessage, tenantId, tenantCode, purpose }, "Message Central OTP delivery failed");
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
    }

    const otp = generateOtp();
    await writeRecord(key, { hash: hash(otp), attempts: 0, sentAt: Date.now(), otpId }, ttl);
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
  async verify({ tenantId, tenantCode, mobile, purpose, otp, otpId }, deps = {}) {
    const ok = await validateOtp({ tenantId, tenantCode, mobile, purpose, otp, otpId }, deps);
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
