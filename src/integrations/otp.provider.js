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
import {
  acquireOtpSendGate,
  budgetKeys,
  challengeRedisKey,
  claimMessageCentralVerify,
  clearOtpSendClaimAtomic,
  consumeValidatedChallenge,
  finalizeMessageCentralValidated,
  incrementAttemptAtomic,
  otpSendGateRedisKey,
  readChallengeJson,
  releaseMessageCentralClaim,
  releaseOtpSendGate,
  releaseOtpSendReservation,
  releaseValidatedSessionClaim,
  reserveOtpSendBudgets,
  reserveOtpSendSlotAtomic,
  resolveOtpBudgetContext,
  rollbackValidatedAtomic,
  validateLocalHashAndClaimSessionAtomic,
  verifyLocalHashAtomic,
  writeChallengeJson,
  claimValidatedSessionLease,
} from "../lib/otp-redis-store.js";

/** Dev/test fallback when Redis is not configured (never used in production OTP paths). */
const memory = new Map();

const hash = (value) => createHash("sha256").update(value).digest("hex");

function resendCooldownSeconds(runtime) {
  return Number(runtime?.OTP_RESEND_COOLDOWN_SECONDS ?? env.OTP_RESEND_COOLDOWN_SECONDS);
}

function challengeKeyFromParams(params) {
  return challengeRedisKey({
    tenantId: params.tenantId,
    tenantCode: params.tenantCode,
    mobile: params.mobile,
    purpose: params.purpose,
  });
}

async function readRecord(key) {
  if (redisReady()) {
    const raw = await getRedis().get(key);
    return raw ? JSON.parse(raw) : null;
  }
  const record = memory.get(key);
  if (!record) return null;
  if (record.expiresAt < Date.now()) {
    memory.delete(key);
    return null;
  }
  return record;
}

async function writeRecordMemory(key, record, ttlSeconds) {
  const payload = { ...record, expiresAt: record.expiresAt ?? Date.now() + ttlSeconds * 1000 };
  memory.set(key, payload);
}

async function deleteRecordAny(key) {
  if (redisReady()) await getRedis().del(key);
  else memory.delete(key);
}

function runtimeEnv(deps) {
  return deps.env ?? env;
}

function maxAttempts(runtime) {
  return Number(runtime.OTP_MAX_ATTEMPTS ?? 5);
}

async function assertProductionRedisReady(runtime) {
  if (runtime.NODE_ENV !== "production") return;
  if (!redisReady()) {
    throw new AppError(
      "OTP_REDIS_UNAVAILABLE",
      "Verification service is temporarily unavailable.",
      503,
    );
  }
  try {
    await getRedis().ping();
  } catch {
    throw new AppError(
      "OTP_REDIS_UNAVAILABLE",
      "Verification service is temporarily unavailable.",
      503,
    );
  }
}

async function maybeReserveBudgets({ runtime, params, countryCode, request, providerChannel }) {
  if (!redisReady()) return { reserved: false, keys: null };
  const redis = getRedis();
  const bc = resolveOtpBudgetContext({
    mobile: params.mobile,
    countryCode,
    tenantId: params.tenantId,
    tenantCode: params.tenantCode,
    provider: providerChannel ?? runtime.OTP_PROVIDER,
    request,
  });
  const keys = budgetKeys({
    countryCode: bc.countryCode,
    destinationId: bc.destinationId,
    ipBucket: bc.ipBucket,
    tenantScope: bc.tenantScope,
    providerScope: bc.providerScope,
    windowSec: runtime.OTP_BUDGET_WINDOW_SECONDS,
    nowMs: Date.now(),
  });
  const limits = {
    destination: Number(runtime.OTP_BUDGET_MAX_PER_DESTINATION),
    ip: Number(runtime.OTP_BUDGET_MAX_PER_IP),
    tenant: Number(runtime.OTP_BUDGET_MAX_PER_TENANT),
    provider: Number(runtime.OTP_BUDGET_MAX_PER_PROVIDER),
  };
  const ttlSec = Math.max(runtime.OTP_BUDGET_WINDOW_SECONDS, 60);
  const res = await reserveOtpSendBudgets(redis, keys, limits, ttlSec);
  if (!res.ok) {
    logger.warn(
      {
        event: "otp_budget_exhausted",
        exhausted: res.exhausted,
        tenantScope: bc.tenantScope,
        provider: bc.providerScope,
      },
      "OTP send rate budget exhausted",
    );
    const retryAfter = runtime.OTP_BUDGET_WINDOW_SECONDS;
    throw new AppError(
      "OTP_RATE_LIMITED",
      "Too many verification requests. Please try again later.",
      429,
      { retryAfterSeconds: retryAfter, exhausted: res.exhausted },
    );
  }
  return { reserved: true, keys };
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

function generateOtpDigits(length) {
  const len = Math.min(8, Math.max(4, Number(length) || 6));
  if (env.NODE_ENV === "test" || env.NODE_ENV === "development") {
    return len === 4 ? "1234" : len === 8 ? "12345678" : "123456";
  }
  const min = 10 ** (len - 1);
  const max = 10 ** len - 1;
  return String(randomInt(min, max + 1));
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

async function validateOtpLocal(params, deps = {}) {
  const key = challengeKeyFromParams(params);
  const otpValue = String(params.otp ?? "").trim();
  const rt = runtimeEnv(deps);
  if (!redisReady()) {
    const record = await readRecord(key);
    if (!record || record.attempts >= maxAttempts(rt)) return { ok: false };
    if (params.otpId && record.otpId && record.otpId !== params.otpId) return { ok: false };
    if (record.validatedAt) return { ok: false };
    if (record.hash !== hash(otpValue)) {
      record.attempts += 1;
      const ttl = Math.max(1, Math.ceil(((record.expiresAt ?? Date.now()) - Date.now()) / 1000));
      await writeRecordMemory(key, record, ttl);
      return { ok: false };
    }
    const va = Date.now();
    record.validatedAt = va;
    const ttlMem = Math.max(1, Math.ceil(((record.expiresAt ?? Date.now()) - Date.now()) / 1000));
    await writeRecordMemory(key, record, ttlMem);
    return { ok: true, validatedAt: va };
  }
  const redis = getRedis();
  const r = await verifyLocalHashAtomic(redis, key, {
    otpId: params.otpId ? String(params.otpId) : "",
    otpPlain: otpValue,
    nowMs: Date.now(),
    maxAttempts: maxAttempts(rt),
  });
  if (r.status === "ok") return { ok: true, validatedAt: r.validatedAt };
  return { ok: false };
}

async function validateOtpMessageCentral(params, deps = {}) {
  const runtime = runtimeEnv(deps);
  const key = challengeKeyFromParams(params);
  const redis = redisReady() ? getRedis() : null;
  let record = redis ? await readChallengeJson(redis, key) : await readRecord(key);
  if (!record || record.provider !== "message_central") return { ok: false };
  if (record.validatedAt) return { ok: false };
  if (record.attempts >= maxAttempts(runtime)) return { ok: false };
  if (params.otpId && record.otpId && record.otpId !== params.otpId) return { ok: false };

  const credentials = deps.messageCentralCredentials
    ?? (params.tenantId
      ? await loadTenantMessageCentralCredentials(params.tenantId)
      : loadPlatformMessageCentralCredentials(deps.env ?? env));
  if (!credentials) return { ok: false };

  const expectedLength = Number(record.otpLength ?? credentials.otpLength ?? 6);
  if (!new RegExp(`^\\d{${expectedLength}}$`).test(String(params.otp ?? "").trim())) {
    if (redis) {
      const inc = await incrementAttemptAtomic(redis, key, {
        otpId: record.otpId ? String(record.otpId) : "",
        nowMs: Date.now(),
        maxAttempts: maxAttempts(runtime),
      });
      if (inc.status === "bad") return { ok: false };
    } else {
      record.attempts += 1;
      const ttl = Math.max(1, Math.ceil(((record.expiresAt ?? Date.now()) - Date.now()) / 1000));
      await writeRecordMemory(key, record, ttl);
    }
    return { ok: false };
  }

  let claimUntil = null;
  if (redis) {
    const leaseMs = runtime.OTP_MC_VERIFY_LEASE_MS;
    const claim = await claimMessageCentralVerify(redis, key, {
      otpId: record.otpId ? String(record.otpId) : "",
      verificationId: record.verificationId,
      nowMs: Date.now(),
      leaseMs,
    });
    if (claim.status === "claimed") return { ok: false };
    if (claim.status !== "ok") return { ok: false };
    claimUntil = claim.claimUntilMs;
  }

  try {
    const authToken = await getMessageCentralAuthToken(
      credentials,
      params.tenantId ?? "platform",
      deps,
    );
    const result = await validateMessageCentralOtp(
      { authToken, verificationId: record.verificationId, code: params.otp },
      deps,
    );
    if (!result.ok) {
      if (redis) {
        await releaseMessageCentralClaim(redis, key, {
          otpId: record.otpId ? String(record.otpId) : "",
          claimUntilMs: claimUntil,
        });
        const inc = await incrementAttemptAtomic(redis, key, {
          otpId: record.otpId ? String(record.otpId) : "",
          nowMs: Date.now(),
          maxAttempts: maxAttempts(runtime),
        });
        if (inc.status === "bad") return { ok: false };
      } else {
        record.attempts += 1;
        const ttl = Math.max(1, Math.ceil(((record.expiresAt ?? Date.now()) - Date.now()) / 1000));
        await writeRecordMemory(key, record, ttl);
      }
      return { ok: false };
    }
    if (redis) {
      const done = await finalizeMessageCentralValidated(redis, key, {
        otpId: record.otpId ? String(record.otpId) : "",
        verificationId: record.verificationId,
        claimUntilMs: claimUntil,
        nowMs: Date.now(),
      });
      if (done.status !== "ok") return { ok: false };
      return { ok: true, validatedAt: done.validatedAt };
    }
    const va = Date.now();
    record.validatedAt = va;
    record.claimUntilMs = undefined;
    const ttl = Math.max(1, Math.ceil(((record.expiresAt ?? Date.now()) - Date.now()) / 1000));
    await writeRecordMemory(key, record, ttl);
    return { ok: true, validatedAt: va };
  } catch (err) {
    logger.error({ err: err?.message, tenantId: params.tenantId, purpose: params.purpose }, "Message Central OTP validate failed");
    if (redis && claimUntil != null) {
      await releaseMessageCentralClaim(redis, key, {
        otpId: record.otpId ? String(record.otpId) : "",
        claimUntilMs: claimUntil,
      });
    }
    return { ok: false };
  }
}

async function validateOtp(params, deps = {}) {
  const record = await readRecord(challengeKeyFromParams(params));
  if (record?.validatedAt) return { ok: false };
  if (record?.provider === "message_central") {
    return validateOtpMessageCentral(params, deps);
  }
  return validateOtpLocal(params, deps);
}

async function prepareSendSlot({ key, params, runtime }, deps = {}) {
  const inflightLease = Number(runtime.OTP_SEND_INFLIGHT_LEASE_MS ?? env.OTP_SEND_INFLIGHT_LEASE_MS);
  const gateKey = otpSendGateRedisKey(params);
  if (!redisReady()) {
    const existing = memory.get(key);
    const cd = resendCooldownSeconds(runtime);
    if (cd > 0 && existing?.sentAt && Date.now() - existing.sentAt < cd * 1000) {
      throw new AppError(
        "OTP_RESEND_COOLDOWN",
        `Please wait ${cd} seconds before requesting another OTP.`,
        429,
        { resendAvailableInSeconds: cd },
      );
    }
    return { gateKey, gateHeld: false, sendClaimUntilMs: null, inflightLease };
  }
  const redis = getRedis();
  const hooks = deps.otpTestHooks;
  const existingRow = await readChallengeJson(redis, key);
  if (!existingRow) {
    if (hooks?.beforeAcquireSendGate) await hooks.beforeAcquireSendGate();
    const g = await acquireOtpSendGate(redis, gateKey, inflightLease);
    if (!g.ok) {
      throw new AppError(
        "OTP_RESEND_COOLDOWN",
        "Another verification request is in progress. Please try again in a moment.",
        429,
        { resendAvailableInSeconds: Math.max(1, Math.ceil(inflightLease / 1000)) },
      );
    }
    try {
      const rowAfter = await readChallengeJson(redis, key);
      if (rowAfter) {
        await releaseOtpSendGate(redis, gateKey);
        const slot2 = await reserveOtpSendSlotAtomic(redis, key, {
          cooldownSec: resendCooldownSeconds(runtime),
          leaseMs: inflightLease,
          nowMs: Date.now(),
        });
        if (slot2.status === "cooldown") {
          throw new AppError(
            "OTP_RESEND_COOLDOWN",
            `Please wait ${slot2.waitSec} seconds before requesting another OTP.`,
            429,
            { resendAvailableInSeconds: slot2.waitSec },
          );
        }
        if (slot2.status === "inflight") {
          throw new AppError(
            "OTP_RESEND_COOLDOWN",
            "Another verification request is in progress. Please try again in a moment.",
            429,
            { resendAvailableInSeconds: Math.max(1, Math.ceil(inflightLease / 1000)) },
          );
        }
        if (slot2.status !== "ok") {
          throw new AppError("OTP_DELIVERY_FAILED", "Could not send the verification code. Please try again.", 502);
        }
        return { gateKey, gateHeld: false, sendClaimUntilMs: slot2.sendClaimUntilMs ?? null, inflightLease };
      }
    } catch (e) {
      await releaseOtpSendGate(redis, gateKey);
      throw e;
    }
    return { gateKey, gateHeld: true, sendClaimUntilMs: null, inflightLease };
  }
  const slot = await reserveOtpSendSlotAtomic(redis, key, {
    cooldownSec: resendCooldownSeconds(runtime),
    leaseMs: inflightLease,
    nowMs: Date.now(),
  });
  if (slot.status === "cooldown") {
    throw new AppError(
      "OTP_RESEND_COOLDOWN",
      `Please wait ${slot.waitSec} seconds before requesting another OTP.`,
      429,
      { resendAvailableInSeconds: slot.waitSec },
    );
  }
  if (slot.status === "inflight") {
    throw new AppError(
      "OTP_RESEND_COOLDOWN",
      "Another verification request is in progress. Please try again in a moment.",
      429,
      { resendAvailableInSeconds: Math.max(1, Math.ceil(inflightLease / 1000)) },
    );
  }
  if (slot.status !== "ok") {
    throw new AppError("OTP_DELIVERY_FAILED", "Could not send the verification code. Please try again.", 502);
  }
  return { gateKey, gateHeld: false, sendClaimUntilMs: slot.sendClaimUntilMs ?? null, inflightLease };
}

async function releaseSendSlot({ key, gateKey, gateHeld, sendClaimUntilMs }) {
  if (!redisReady()) return;
  const redis = getRedis();
  if (gateHeld) await releaseOtpSendGate(redis, gateKey);
  if (sendClaimUntilMs != null) {
    await clearOtpSendClaimAtomic(redis, key, { sendClaimUntilMs, nowMs: Date.now() });
  }
}

/**
 * Validate OTP and bind session issuance lease in one linearizable step for local/redis providers (AUD-04).
 * Message Central: validate then claim (both reject when already bound to another in-flight issuance).
 */
async function validateAndClaimSessionLease(params, deps, sessionToken) {
  const key = challengeKeyFromParams(params);
  const rt = runtimeEnv(deps);
  const leaseMs = Number(rt.OTP_SESSION_ISSUE_LEASE_MS ?? env.OTP_SESSION_ISSUE_LEASE_MS);
  const token = String(sessionToken ?? "");
  if (!token) return { ok: false };

  const record = await readRecord(key);
  if (!record) return { ok: false };

  if (record.provider === "message_central") {
    const check = await validateOtpMessageCentral(params, deps);
    if (!check.ok) return { ok: false };
    const claim = await otpProvider.claimSessionLease({ ...params, sessionToken: token }, deps);
    if (claim.status !== "ok") return { ok: false };
    return { ok: true, validatedAt: claim.validatedAt ?? check.validatedAt };
  }

  if (!redisReady()) {
    const rec = memory.get(key);
    if (!rec || (rec.expiresAt != null && rec.expiresAt < Date.now())) {
      memory.delete(key);
      return { ok: false };
    }
    if (params.otpId && rec.otpId && rec.otpId !== params.otpId) return { ok: false };
    if (rec.validatedAt) return { ok: false };
    if (rec.attempts >= maxAttempts(rt)) return { ok: false };
    const otpValue = String(params.otp ?? "").trim();
    if (rec.hash !== hash(otpValue)) {
      rec.attempts = (rec.attempts ?? 0) + 1;
      const ttl = Math.max(1, Math.ceil(((rec.expiresAt ?? Date.now()) - Date.now()) / 1000));
      await writeRecordMemory(key, rec, ttl);
      return { ok: false };
    }
    const now = Date.now();
    if (rec.sessionClaimToken && rec.sessionClaimToken !== token) {
      const cu = Number(rec.sessionClaimUntilMs) || 0;
      if (cu > now) return { ok: false };
    }
    const va = now;
    rec.validatedAt = va;
    rec.sessionClaimToken = token;
    rec.sessionClaimUntilMs = now + leaseMs;
    const ttlMem = Math.max(1, Math.ceil(((rec.expiresAt ?? Date.now()) - now) / 1000));
    await writeRecordMemory(key, rec, ttlMem);
    return { ok: true, validatedAt: va };
  }

  const redis = getRedis();
  const otpValue = String(params.otp ?? "").trim();
  const r = await validateLocalHashAndClaimSessionAtomic(redis, key, {
    otpId: params.otpId ? String(params.otpId) : "",
    otpPlain: otpValue,
    nowMs: Date.now(),
    maxAttempts: maxAttempts(rt),
    sessionToken: token,
    leaseMs,
  });
  if (r.status !== "ok") return { ok: false };
  return { ok: true, validatedAt: r.validatedAt };
}

export const otpProvider = {
  async send(params, deps = {}) {
    const runtime = runtimeEnv(deps);
    await assertProductionRedisReady(runtime);

    const key = challengeKeyFromParams(params);
    const plan = await resolveDeliveryPlan({ tenantId: params.tenantId, runtime }, deps);
    const ttl = runtime.OTP_TTL_SECONDS;
    const otpId = randomUUID();

    const slotState = await prepareSendSlot({ key, params, runtime }, deps);

    const isRegistered = params.tenantId
      ? Boolean(
          await Customer.exists({
            tenantId: params.tenantId,
            mobile: { $in: mobileLookupVariants(canonicalMobile(params.mobile)) },
          }),
        )
      : false;

    let countryCode = "91";
    let otpLenForMock = 6;
    if (plan.channel === "message_central") {
      countryCode = String(plan.credentials.countryCode ?? "91").replace(/\D/g, "") || "91";
      otpLenForMock = Number(plan.credentials.otpLength ?? 6);
    } else if (plan.channel === "msg91") {
      countryCode = String(runtime.MSG91_DEFAULT_COUNTRY_CODE ?? "91").replace(/\D/g, "") || "91";
      otpLenForMock = 6;
    }

    const existing = await readRecord(key);

    if (plan.channel === "mock") {
      let budgetKeysRef = null;
      try {
        const br = await maybeReserveBudgets({
          runtime,
          params,
          countryCode,
          request: deps.request,
          providerChannel: "mock",
        });
        budgetKeysRef = br.keys;
        const otp = generateOtpDigits(otpLenForMock);
        const rec = {
          provider: "mock",
          hash: hash(otp),
          attempts: 0,
          sentAt: Date.now(),
          otpId,
          otpLength: otpLenForMock,
          countryCode,
          purpose: String(params.purpose),
        };
        if (redisReady()) await writeChallengeJson(getRedis(), key, rec, ttl);
        else await writeRecordMemory(key, rec, ttl);
        if (runtime.NODE_ENV !== "production") {
          logger.info({ tenantId: params.tenantId, tenantCode: params.tenantCode, purpose: params.purpose }, "Mock OTP queued");
        } else {
          logger.info({ tenantId: params.tenantId, tenantCode: params.tenantCode, purpose: params.purpose }, "Mock OTP queued");
        }
        return {
          otpId,
          channel: "SMS",
          maskedMobile: maskMobile(params.mobile),
          resendAvailableInSeconds: resendCooldownSeconds(runtime),
          attemptsAllowed: maxAttempts(runtime),
          isRegistered,
          expiresInSeconds: ttl,
          otpLength: otpLenForMock,
          authCountryCode: countryCode,
        };
      } catch (err) {
        if (budgetKeysRef && redisReady()) await releaseOtpSendReservation(getRedis(), budgetKeysRef);
        throw err;
      } finally {
        await releaseSendSlot({
          key,
          gateKey: slotState.gateKey,
          gateHeld: slotState.gateHeld,
          sendClaimUntilMs: slotState.sendClaimUntilMs,
        });
      }
    }

    if (plan.channel === "message_central") {
      const { credentials } = plan;
      let budgetKeysRef = null;
      try {
        const br = await maybeReserveBudgets({
          runtime,
          params,
          countryCode,
          request: deps.request,
          providerChannel: "message_central",
        });
        budgetKeysRef = br.keys;
        const authToken = await getMessageCentralAuthToken(
          credentials,
          params.tenantId ?? "platform",
          deps,
        );
        const sent = await sendMessageCentralOtp(
          {
            authToken,
            mobile: params.mobile,
            countryCode: credentials.countryCode,
            flowType: credentials.flowType,
            otpLength: credentials.otpLength,
          },
          deps,
        );
        const rec = {
          provider: "message_central",
          verificationId: sent.verificationId,
          otpLength: Number(credentials.otpLength ?? 6),
          countryCode: String(credentials.countryCode ?? "91").replace(/\D/g, "") || "91",
          attempts: 0,
          sentAt: Date.now(),
          otpId,
          purpose: String(params.purpose),
        };
        if (redisReady()) await writeChallengeJson(getRedis(), key, rec, ttl);
        else await writeRecordMemory(key, rec, ttl);
      } catch (err) {
        const mcMessage = String(err?.message ?? "");
        if (mcMessage.includes("REQUEST_ALREADY_EXISTS")) {
          if (budgetKeysRef && redisReady()) await releaseOtpSendReservation(getRedis(), budgetKeysRef);
          if (existing?.provider === "message_central" && existing.verificationId) {
            const reuseOtpId = existing.otpId ?? otpId;
            const next = { ...existing, sentAt: Date.now(), otpId: reuseOtpId };
            if (redisReady()) await writeChallengeJson(getRedis(), key, next, ttl);
            else await writeRecordMemory(key, next, ttl);
            logger.info(
              { tenantId: params.tenantId, tenantCode: params.tenantCode, purpose: params.purpose },
              "Message Central OTP already active — reusing local verification session",
            );
            return {
              otpId: reuseOtpId,
              channel: "SMS",
              maskedMobile: maskMobile(params.mobile),
              resendAvailableInSeconds: resendCooldownSeconds(runtime),
              attemptsAllowed: maxAttempts(runtime),
              isRegistered,
              expiresInSeconds: ttl,
              otpLength: Number(existing.otpLength ?? credentials.otpLength ?? 6),
              authCountryCode: String(credentials.countryCode ?? "91").replace(/\D/g, "") || "91",
            };
          }
          throw new AppError(
            "OTP_RESEND_COOLDOWN",
            "An OTP was already sent to this mobile. Check your messages or wait a few minutes before requesting again.",
            429,
            { resendAvailableInSeconds: resendCooldownSeconds(runtime) },
          );
        }
        if (budgetKeysRef && redisReady()) await releaseOtpSendReservation(getRedis(), budgetKeysRef);
        await deleteRecordAny(key);
        logger.error({ err: mcMessage, tenantId: params.tenantId, tenantCode: params.tenantCode, purpose: params.purpose }, "Message Central OTP delivery failed");
        throw new AppError("OTP_DELIVERY_FAILED", "Could not send the verification code. Please try again.", 502);
      } finally {
        await releaseSendSlot({
          key,
          gateKey: slotState.gateKey,
          gateHeld: slotState.gateHeld,
          sendClaimUntilMs: slotState.sendClaimUntilMs,
        });
      }
      return {
        otpId,
        channel: "SMS",
        maskedMobile: maskMobile(params.mobile),
        resendAvailableInSeconds: resendCooldownSeconds(runtime),
        attemptsAllowed: maxAttempts(runtime),
        isRegistered,
        expiresInSeconds: ttl,
        otpLength: Number(plan.credentials.otpLength ?? 6),
        authCountryCode: countryCode,
      };
    }

    const { keys: budgetKeysRef } = await maybeReserveBudgets({
      runtime,
      params,
      countryCode,
      request: deps.request,
      providerChannel: "msg91",
    });
    const otp = generateOtpDigits(6);
    const rec = {
      provider: "msg91",
      hash: hash(otp),
      attempts: 0,
      sentAt: Date.now(),
      otpId,
      countryCode,
      otpLength: 6,
      purpose: String(params.purpose),
    };
    try {
      if (redisReady()) await writeChallengeJson(getRedis(), key, rec, ttl);
      else await writeRecordMemory(key, rec, ttl);
      await sendMsg91Otp({ mobile: params.mobile, otp }, { fetch: deps.fetch, env: runtime });
    } catch (err) {
      if (budgetKeysRef && redisReady()) await releaseOtpSendReservation(getRedis(), budgetKeysRef);
      await deleteRecordAny(key);
      logger.error({ err: err?.message, tenantId: params.tenantId, tenantCode: params.tenantCode, purpose: params.purpose }, "MSG91 OTP delivery failed");
      throw new AppError("OTP_DELIVERY_FAILED", "Could not send the verification code. Please try again.", 502);
    } finally {
      await releaseSendSlot({
        key,
        gateKey: slotState.gateKey,
        gateHeld: slotState.gateHeld,
        sendClaimUntilMs: slotState.sendClaimUntilMs,
      });
    }
    return {
      otpId,
      channel: "SMS",
      maskedMobile: maskMobile(params.mobile),
      resendAvailableInSeconds: resendCooldownSeconds(runtime),
      attemptsAllowed: maxAttempts(runtime),
      isRegistered,
      expiresInSeconds: ttl,
      otpLength: 6,
      authCountryCode: countryCode,
    };
  },
  validate: validateOtp,
  validateAndClaimSessionLease: validateAndClaimSessionLease,
  async rollbackValidated(params) {
    const key = challengeKeyFromParams(params);
    const otpId = params.otpId ? String(params.otpId) : "";
    const validatedAt = params.validatedAt != null ? Number(params.validatedAt) : undefined;
    const sessionToken = params.sessionToken != null ? String(params.sessionToken) : "";
    if (!redisReady()) {
      const record = memory.get(key);
      if (!record?.validatedAt) return { status: "noop" };
      if (otpId && record.otpId && record.otpId !== otpId) return { status: "noop" };
      if (validatedAt != null && Number(record.validatedAt) !== validatedAt) return { status: "noop" };
      if (sessionToken && String(record.sessionClaimToken ?? "") !== sessionToken) return { status: "noop" };
      if (!sessionToken && record.sessionClaimToken) return { status: "noop" };
      delete record.validatedAt;
      delete record.sessionClaimUntilMs;
      delete record.sessionClaimToken;
      memory.set(key, record);
      return { status: "ok" };
    }
    return rollbackValidatedAtomic(getRedis(), key, { otpId, validatedAt, sessionToken });
  },
  async claimSessionLease(params, deps = {}) {
    const runtime = runtimeEnv(deps);
    const key = challengeKeyFromParams(params);
    const token = String(params.sessionToken ?? "");
    const leaseMs = Number(runtime.OTP_SESSION_ISSUE_LEASE_MS ?? env.OTP_SESSION_ISSUE_LEASE_MS);
    if (!redisReady()) {
      const record = memory.get(key);
      if (!record?.validatedAt) return { status: "gone" };
      if (params.otpId && record.otpId && record.otpId !== params.otpId) return { status: "otp_id_mismatch" };
      const now = Date.now();
      if (record.sessionClaimToken) {
        if (record.sessionClaimToken !== token) {
          const cu = Number(record.sessionClaimUntilMs) || 0;
          if (cu > now) return { status: "claimed" };
        }
      }
      record.sessionClaimToken = token;
      record.sessionClaimUntilMs = now + leaseMs;
      memory.set(key, record);
      return { status: "ok", validatedAt: record.validatedAt };
    }
    return claimValidatedSessionLease(getRedis(), key, {
      otpId: params.otpId ? String(params.otpId) : "",
      sessionToken: token,
      nowMs: Date.now(),
      leaseMs,
    });
  },
  async releaseSessionLease(params) {
    const key = challengeKeyFromParams(params);
    if (!redisReady()) {
      const record = memory.get(key);
      if (!record) return { status: "gone" };
      if (params.otpId && record.otpId && record.otpId !== params.otpId) return { status: "noop" };
      if (record.sessionClaimToken !== params.sessionToken) return { status: "noop" };
      delete record.sessionClaimUntilMs;
      delete record.sessionClaimToken;
      memory.set(key, record);
      return { status: "ok" };
    }
    return releaseValidatedSessionClaim(getRedis(), key, {
      otpId: params.otpId ? String(params.otpId) : "",
      sessionToken: String(params.sessionToken ?? ""),
      validatedAt: params.validatedAt,
    });
  },
  async consume(params) {
    const key = challengeKeyFromParams(params);
    const rawTok = params.sessionToken;
    if (rawTok == null || rawTok === "") return { status: "bad_token" };
    const token = String(rawTok);
    if (!redisReady()) {
      const record = memory.get(key);
      if (!record?.validatedAt) return { status: "gone" };
      if (params.otpId && record.otpId && record.otpId !== params.otpId) return { status: "otp_id_mismatch" };
      if (record.sessionClaimToken !== token) return { status: "not_claimed" };
      memory.delete(key);
      return { status: "ok" };
    }
    return consumeValidatedChallenge(getRedis(), key, {
      otpId: params.otpId ? String(params.otpId) : "",
      sessionToken: token,
      nowMs: Date.now(),
    });
  },
  async verify(params, deps = {}) {
    const sessionToken = randomUUID();
    const issued = await validateAndClaimSessionLease(params, deps, sessionToken);
    if (!issued.ok) return false;
    const consumed = await otpProvider.consume({ ...params, sessionToken }, deps);
    if (consumed.status !== "ok") {
      await otpProvider.releaseSessionLease(
        { ...params, sessionToken, validatedAt: issued.validatedAt },
        deps,
      );
      return false;
    }
    return true;
  },
  /** When verify fails, detect OTP issued for the other customer auth purpose (LOGIN vs SIGNUP). */
  async findMatchingPurpose({ tenantId, tenantCode, mobile, purpose, otpId }) {
    if (!otpId) return null;
    for (const alt of ["LOGIN", "SIGNUP"]) {
      if (alt === purpose) continue;
      const record = await readRecord(
        challengeRedisKey({ tenantId, tenantCode, mobile, purpose: alt }),
      );
      if (record?.otpId === otpId) return alt;
    }
    return null;
  },
};
