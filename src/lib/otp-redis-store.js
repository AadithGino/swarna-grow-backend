/**
 * Redis-backed OTP challenge storage with atomic verify/consume (AUD-04/05).
 * All challenge keys are JSON blobs; mutations run via Lua for linearizability.
 */
import { createHash } from "node:crypto";
import { canonicalMobile } from "./mobile.js";
import { getRedis, redisReady } from "../config/redis.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function challengeRedisKey(ctx) {
  const normalizedMobile = canonicalMobile(ctx.mobile);
  const scope =
    ctx.tenantId != null
      ? `t:${String(ctx.tenantId)}`
      : `c:${String(ctx.tenantCode ?? "platform")}`;
  const purpose = String(ctx.purpose ?? "");
  return `otp:ch:${scope}:${normalizedMobile}:${purpose}`;
}

/** NX gate for first send before challenge row exists (concurrent send serialization). */
export function otpSendGateRedisKey(params) {
  return `otp:sg:${challengeRedisKey(params)}`;
}

export function budgetKeys({ countryCode, destinationId, ipBucket, tenantScope, providerScope, windowSec, nowMs }) {
  const wid = currentWindowId(nowMs ?? Date.now(), windowSec);
  const w = `${windowSec}:${wid}`;
  const cc = String(countryCode ?? "91");
  return {
    destination: `otp:bg:dst:${cc}:${destinationId}:${w}`,
    ip: `otp:bg:ip:${ipBucket}:${w}`,
    tenant: `otp:bg:tn:${tenantScope}:${w}`,
    provider: `otp:bg:pv:${providerScope}:${w}`,
  };
}

function ipBucketFromRequest(req) {
  const raw = req?.ip ?? req?.connection?.remoteAddress ?? "unknown";
  return sha256(String(raw));
}

/**
 * @param {object} params
 * @param {string} params.provider — mock | msg91 | message_central
 * @param {object} [params.request]
 */
export function resolveOtpBudgetContext(params) {
  const mobile = canonicalMobile(params.mobile);
  const digits = String(mobile).replace(/\D/g, "");
  const countryCode = String(params.countryCode ?? "91");
  const destinationId = sha256(`${countryCode}:${digits}`);
  const ipBucket = params.request ? ipBucketFromRequest(params.request) : sha256("n/a");
  const tenantScope =
    params.tenantId != null
      ? String(params.tenantId)
      : `code:${String(params.tenantCode ?? "merchant_signup")}`;
  const providerScope = String(params.provider ?? env.OTP_PROVIDER ?? "mock");
  return { countryCode, destinationId, ipBucket, tenantScope, providerScope };
}

/** Increment sorted-set style windows (one key per window bucket). */
export function currentWindowId(nowMs, windowSec) {
  return Math.floor(nowMs / (windowSec * 1000));
}

const RESERVE_BUDGET_LUA = `
local kDest = KEYS[1]
local kIp = KEYS[2]
local kTenant = KEYS[3]
local kProv = KEYS[4]
local limitDest = tonumber(ARGV[1])
local limitIp = tonumber(ARGV[2])
local limitTenant = tonumber(ARGV[3])
local limitProv = tonumber(ARGV[4])
local ttlSec = tonumber(ARGV[5])

local function count(key)
  local v = redis.call("GET", key)
  if v == false then return 0 end
  return tonumber(v) or 0
end

local function bump(key)
  local n = redis.call("INCR", key)
  if n == 1 then redis.call("EXPIRE", key, ttlSec) end
  return n
end

local cDest = count(kDest)
local cIp = count(kIp)
local cTenant = count(kTenant)
local cProv = count(kProv)
if cDest >= limitDest then return {"dest", cDest} end
if cIp >= limitIp then return {"ip", cIp} end
if cTenant >= limitTenant then return {"tenant", cTenant} end
if cProv >= limitProv then return {"prov", cProv} end

local nDest = bump(kDest)
local nIp = bump(kIp)
local nTenant = bump(kTenant)
local nProv = bump(kProv)
return {"ok", nDest, nIp, nTenant, nProv}
`;

/** Reserve one send slot across four independent budgets (atomic Lua; no partial increments on reject). */
export async function reserveOtpSendBudgets(redis, keys, limits, ttlSec) {
  const res = await redis.eval(
    RESERVE_BUDGET_LUA,
    4,
    keys.destination,
    keys.ip,
    keys.tenant,
    keys.provider,
    limits.destination,
    limits.ip,
    limits.tenant,
    limits.provider,
    ttlSec,
  );
  if (!Array.isArray(res)) throw new Error("OTP budget script malformed");
  const kind = res[0];
  if (kind === "ok") return { ok: true };
  return { ok: false, exhausted: res[0], count: res[1] };
}

/** Decrement budget counters after a failed provider send — single atomic script (AUD-05). */
const RELEASE_BUDGET_LUA = `
local kDest = KEYS[1]
local kIp = KEYS[2]
local kTenant = KEYS[3]
local kProv = KEYS[4]

local function decrDel(key)
  local v = redis.call("GET", key)
  if v == false then return end
  local n = tonumber(v) or 0
  if n <= 1 then redis.call("DEL", key)
  else redis.call("DECR", key) end
end

decrDel(kDest)
decrDel(kIp)
decrDel(kTenant)
decrDel(kProv)
return {"ok"}
`;

export async function releaseOtpSendReservation(redis, keys) {
  if (!keys?.destination) return;
  try {
    await redis.eval(RELEASE_BUDGET_LUA, 4, keys.destination, keys.ip, keys.tenant, keys.provider);
  } catch (err) {
    logger.warn({ err: err?.message }, "OTP budget release failed");
  }
}

const VERIFY_LOCAL_LUA = `
local key = KEYS[1]
local expectedOtpId = ARGV[1]
local otpHash = ARGV[2]
local nowMs = tonumber(ARGV[3])
local maxAttempts = tonumber(ARGV[4])

local raw = redis.call("GET", key)
if raw == false then return {"gone"} end
local r = cjson.decode(raw)
if expectedOtpId ~= "" and r.otpId ~= expectedOtpId then return {"otpId_mismatch"} end
if tonumber(r.expiresAt) and nowMs > tonumber(r.expiresAt) then return {"expired"} end
local at = tonumber(r.attempts) or 0
local max = tonumber(r.maxAttempts or maxAttempts)
if at >= max then return {"locked", at} end
if r.validatedAt then return {"reuse"} end
if r.hash ~= otpHash then
  r.attempts = at + 1
  redis.call("SET", key, cjson.encode(r), "KEEPTTL")
  return {"bad", r.attempts}
end
r.validatedAt = nowMs
redis.call("SET", key, cjson.encode(r), "KEEPTTL")
return {"ok", tostring(r.validatedAt)}
`;

const CONSUME_VALIDATED_LUA = `
local key = KEYS[1]
local expectedOtpId = ARGV[1]
local sessionToken = ARGV[2]
local nowMs = tonumber(ARGV[3])

local raw = redis.call("GET", key)
if raw == false then return {"gone"} end
local r = cjson.decode(raw)
if expectedOtpId ~= "" and r.otpId ~= expectedOtpId then return {"otpId_mismatch"} end
if not r.validatedAt then return {"not_validated"} end
if sessionToken == nil or sessionToken == false or sessionToken == "" then return {"bad_token"} end
local tok = r.sessionClaimToken
if tok == nil or tok == false or tok == "" then return {"not_claimed"} end
if tok ~= sessionToken then return {"claim_token_mismatch"} end
local cu = tonumber(r.sessionClaimUntilMs) or 0
if cu > 0 and nowMs > cu then return {"claim_expired"} end
redis.call("DEL", key)
return {"ok"}
`;

/** Single linearizable step: verify local hash, set validatedAt, bind session lease (AUD-04). */
const VALIDATE_LOCAL_AND_CLAIM_SESSION_LUA = `
local key = KEYS[1]
local expectedOtpId = ARGV[1]
local otpHash = ARGV[2]
local nowMs = tonumber(ARGV[3])
local maxAttempts = tonumber(ARGV[4])
local sessionToken = ARGV[5]
local leaseMs = tonumber(ARGV[6])

if sessionToken == nil or sessionToken == false or sessionToken == "" then return {"bad_token"} end

local raw = redis.call("GET", key)
if raw == false then return {"gone"} end
local r = cjson.decode(raw)
if expectedOtpId ~= "" and r.otpId ~= expectedOtpId then return {"otpId_mismatch"} end
if tonumber(r.expiresAt) and nowMs > tonumber(r.expiresAt) then return {"expired"} end
local at = tonumber(r.attempts) or 0
local max = tonumber(r.maxAttempts or maxAttempts)
if at >= max then return {"locked", at} end
if r.validatedAt then return {"reuse"} end
if r.hash ~= otpHash then
  r.attempts = at + 1
  redis.call("SET", key, cjson.encode(r), "KEEPTTL")
  return {"bad", r.attempts}
end
r.validatedAt = nowMs
r.sessionClaimUntilMs = nowMs + leaseMs
r.sessionClaimToken = sessionToken
redis.call("SET", key, cjson.encode(r), "KEEPTTL")
return {"ok", tostring(r.validatedAt)}
`;

/** Reserve validated challenge for a single session issuance (AUD-04). */
const CLAIM_VALIDATED_SESSION_LUA = `
local key = KEYS[1]
local expectedOtpId = ARGV[1]
local sessionToken = ARGV[2]
local nowMs = tonumber(ARGV[3])
local leaseMs = tonumber(ARGV[4])

local raw = redis.call("GET", key)
if raw == false then return {"gone"} end
local r = cjson.decode(raw)
if expectedOtpId ~= "" and r.otpId ~= expectedOtpId then return {"otpId_mismatch"} end
if not r.validatedAt then return {"not_validated"} end
local cu = tonumber(r.sessionClaimUntilMs) or 0
local existingTok = r.sessionClaimToken
if existingTok == sessionToken and cu > nowMs then
  return {"ok", tostring(r.validatedAt)}
end
if cu > nowMs then return {"claimed"} end
r.sessionClaimUntilMs = nowMs + leaseMs
r.sessionClaimToken = sessionToken
redis.call("SET", key, cjson.encode(r), "KEEPTTL")
return {"ok", tostring(r.validatedAt)}
`;

const RELEASE_VALIDATED_SESSION_CLAIM_LUA = `
local key = KEYS[1]
local expectedOtpId = ARGV[1]
local sessionToken = ARGV[2]
local validatedAtExpect = ARGV[3]

local raw = redis.call("GET", key)
if raw == false then return {"gone"} end
local r = cjson.decode(raw)
if expectedOtpId ~= "" and r.otpId ~= expectedOtpId then return {"noop"} end
if not r.validatedAt then return {"noop"} end
if validatedAtExpect ~= "" and tostring(r.validatedAt) ~= validatedAtExpect then return {"noop"} end
if r.sessionClaimToken ~= sessionToken then return {"noop"} end
r.sessionClaimUntilMs = nil
r.sessionClaimToken = nil
redis.call("SET", key, cjson.encode(r), "KEEPTTL")
return {"ok"}
`;

const ROLLBACK_VALIDATED_LUA = `
local key = KEYS[1]
local expectedOtpId = ARGV[1]
local validatedAtExpect = ARGV[2]
local sessionTokenExpect = ARGV[3]

local raw = redis.call("GET", key)
if raw == false then return {"gone"} end
local r = cjson.decode(raw)
if expectedOtpId ~= "" and r.otpId ~= expectedOtpId then return {"noop"} end
if not r.validatedAt then return {"noop"} end
if validatedAtExpect ~= "" and tostring(r.validatedAt) ~= validatedAtExpect then return {"noop"} end
local st = r.sessionClaimToken
if sessionTokenExpect ~= nil and sessionTokenExpect ~= false and sessionTokenExpect ~= "" then
  if st == nil or st == false or st == "" then return {"noop"} end
  if st ~= sessionTokenExpect then return {"noop"} end
elseif st ~= nil and st ~= false and st ~= "" then
  return {"noop"}
end
r.validatedAt = nil
r.sessionClaimUntilMs = nil
r.sessionClaimToken = nil
redis.call("SET", key, cjson.encode(r), "KEEPTTL")
return {"ok"}
`;

/** Atomically reserve send slot (cooldown + in-flight) before provider dispatch (AUD-05). */
const RESERVE_OTP_SEND_LUA = `
local key = KEYS[1]
local cooldownSec = tonumber(ARGV[1])
local leaseMs = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])

local raw = redis.call("GET", key)
if raw ~= false then
  local r = cjson.decode(raw)
  local sc = tonumber(r.sendClaimUntilMs) or 0
  if sc > nowMs then return {"inflight"} end
  local sentAt = tonumber(r.sentAt) or 0
  if cooldownSec > 0 and sentAt > 0 and (nowMs - sentAt) < cooldownSec * 1000 then
    local waitMs = cooldownSec * 1000 - (nowMs - sentAt)
    local waitSec = math.ceil(waitMs / 1000)
    return {"cooldown", waitSec}
  end
  r.sendClaimUntilMs = nowMs + leaseMs
  redis.call("SET", key, cjson.encode(r), "KEEPTTL")
  return {"ok", tostring(r.sendClaimUntilMs)}
end
return {"ok", "no_key"}
`;

const CLEAR_OTP_SEND_CLAIM_LUA = `
local key = KEYS[1]
local expectedClaimUntil = ARGV[1]
local nowMs = tonumber(ARGV[2])

local raw = redis.call("GET", key)
if raw == false then return {"gone"} end
local r = cjson.decode(raw)
local sc = tonumber(r.sendClaimUntilMs) or 0
if sc == 0 then return {"ok"} end
if expectedClaimUntil ~= "" and tostring(sc) ~= expectedClaimUntil then return {"claim_mismatch"} end
if sc < nowMs then return {"claim_expired"} end
r.sendClaimUntilMs = nil
redis.call("SET", key, cjson.encode(r), "KEEPTTL")
return {"ok"}
`;

const INCREMENT_ATTEMPT_LUA = `
local key = KEYS[1]
local expectedOtpId = ARGV[1]
local nowMs = tonumber(ARGV[2])
local maxAttempts = tonumber(ARGV[3])

local raw = redis.call("GET", key)
if raw == false then return {"gone"} end
local r = cjson.decode(raw)
if expectedOtpId ~= "" and r.otpId ~= expectedOtpId then return {"otpId_mismatch"} end
if tonumber(r.expiresAt) and nowMs > tonumber(r.expiresAt) then return {"expired"} end
local at = tonumber(r.attempts) or 0
local max = tonumber(r.maxAttempts or maxAttempts)
if at >= max then return {"locked", at} end
r.attempts = at + 1
redis.call("SET", key, cjson.encode(r), "KEEPTTL")
return {"bad", r.attempts}
`;

const DELETE_IF_OTPID_LUA = `
local key = KEYS[1]
local expectedOtpId = ARGV[1]
local raw = redis.call("GET", key)
if raw == false then return {"gone"} end
local r = cjson.decode(raw)
if expectedOtpId ~= "" and r.otpId ~= expectedOtpId then return {"otpId_mismatch"} end
redis.call("DEL", key)
return {"ok"}
`;

/** Claim exclusive rights to validate with external provider (prevents slow verify on replaced challenge). */
const CLAIM_MC_LUA = `
local key = KEYS[1]
local expectedOtpId = ARGV[1]
local expectedVid = ARGV[2]
local nowMs = tonumber(ARGV[3])
local leaseMs = tonumber(ARGV[4])

local raw = redis.call("GET", key)
if raw == false then return {"gone"} end
local r = cjson.decode(raw)
if expectedOtpId ~= "" and r.otpId ~= expectedOtpId then return {"otpId_mismatch"} end
if r.provider ~= "message_central" then return {"wrong_provider"} end
if expectedVid ~= "" and r.verificationId ~= expectedVid then return {"vid_mismatch"} end
if tonumber(r.expiresAt) and nowMs > tonumber(r.expiresAt) then return {"expired"} end
local claimUntil = tonumber(r.claimUntilMs) or 0
if claimUntil > nowMs then return {"claimed", claimUntil} end
r.claimUntilMs = nowMs + leaseMs
redis.call("SET", key, cjson.encode(r), "KEEPTTL")
return {"ok", r.claimUntilMs}
`;

const COMPLETE_MC_LUA = `
local key = KEYS[1]
local expectedOtpId = ARGV[1]
local expectedVid = ARGV[2]
local claimUntil = tonumber(ARGV[3])
local nowMs = tonumber(ARGV[4])

local raw = redis.call("GET", key)
if raw == false then return {"gone"} end
local r = cjson.decode(raw)
if expectedOtpId ~= "" and r.otpId ~= expectedOtpId then return {"otpId_mismatch"} end
if r.provider ~= "message_central" then return {"wrong_provider"} end
if r.verificationId ~= expectedVid then return {"vid_mismatch"} end
local c = tonumber(r.claimUntilMs) or 0
if c ~= claimUntil then return {"claim_mismatch", c} end
if c < nowMs then return {"claim_expired"} end
r.claimUntilMs = nil
r.validatedAt = nowMs
redis.call("SET", key, cjson.encode(r), "KEEPTTL")
return {"ok", tostring(r.validatedAt)}
`;

const RELEASE_MC_CLAIM_LUA = `
local key = KEYS[1]
local expectedOtpId = ARGV[1]
local claimUntil = tonumber(ARGV[2])

local raw = redis.call("GET", key)
if raw == false then return {"gone"} end
local r = cjson.decode(raw)
if expectedOtpId ~= "" and r.otpId ~= expectedOtpId then return {"otpId_mismatch"} end
local c = tonumber(r.claimUntilMs) or 0
if claimUntil > 0 and c ~= claimUntil then return {"claim_mismatch", c} end
r.claimUntilMs = nil
redis.call("SET", key, cjson.encode(r), "KEEPTTL")
return {"ok"}
`;

const FINALIZE_MC_VALIDATED_LUA = `
local key = KEYS[1]
local expectedOtpId = ARGV[1]
local expectedVid = ARGV[2]
local claimUntil = tonumber(ARGV[3])
local nowMs = tonumber(ARGV[4])

local raw = redis.call("GET", key)
if raw == false then return {"gone"} end
local r = cjson.decode(raw)
if expectedOtpId ~= "" and r.otpId ~= expectedOtpId then return {"otpId_mismatch"} end
if r.provider ~= "message_central" then return {"wrong_provider"} end
if r.verificationId ~= expectedVid then return {"vid_mismatch"} end
local c = tonumber(r.claimUntilMs) or 0
if claimUntil > 0 and c ~= claimUntil then return {"claim_mismatch", c} end
if claimUntil > 0 and c < nowMs then return {"claim_expired"} end
r.claimUntilMs = nil
r.validatedAt = nowMs
redis.call("SET", key, cjson.encode(r), "KEEPTTL")
return {"ok", tostring(r.validatedAt)}
`;

export async function readChallengeJson(redis, key) {
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function verifyLocalHashAtomic(redis, key, { otpId, otpPlain, nowMs, maxAttempts }) {
  const otpHash = sha256(String(otpPlain ?? "").trim());
  const res = await redis.eval(
    VERIFY_LOCAL_LUA,
    1,
    key,
    otpId,
    otpHash,
    String(nowMs),
    String(maxAttempts),
  );
  return normalizeVerifyResult(res);
}

export async function incrementAttemptAtomic(redis, key, { otpId, nowMs, maxAttempts }) {
  const res = await redis.eval(
    INCREMENT_ATTEMPT_LUA,
    1,
    key,
    otpId,
    String(nowMs),
    String(maxAttempts),
  );
  return normalizeVerifyResult(res);
}

export async function consumeValidatedChallenge(
  redis,
  key,
  { otpId, sessionToken, nowMs },
) {
  const res = await redis.eval(
    CONSUME_VALIDATED_LUA,
    1,
    key,
    otpId ? String(otpId) : "",
    sessionToken != null ? String(sessionToken) : "",
    String(nowMs ?? Date.now()),
  );
  return normalizeVerifyResult(res);
}

export async function validateLocalHashAndClaimSessionAtomic(
  redis,
  key,
  { otpId, otpPlain, nowMs, maxAttempts, sessionToken, leaseMs },
) {
  const otpHash = sha256(String(otpPlain ?? "").trim());
  const res = await redis.eval(
    VALIDATE_LOCAL_AND_CLAIM_SESSION_LUA,
    1,
    key,
    otpId ? String(otpId) : "",
    otpHash,
    String(nowMs ?? Date.now()),
    String(maxAttempts),
    String(sessionToken ?? ""),
    String(leaseMs ?? 120_000),
  );
  return normalizeVerifyResult(res);
}

export async function claimValidatedSessionLease(
  redis,
  key,
  { otpId, sessionToken, nowMs, leaseMs },
) {
  const res = await redis.eval(
    CLAIM_VALIDATED_SESSION_LUA,
    1,
    key,
    otpId ? String(otpId) : "",
    String(sessionToken ?? ""),
    String(nowMs ?? Date.now()),
    String(leaseMs ?? 120_000),
  );
  return normalizeSessionClaimResult(res);
}

export async function releaseValidatedSessionClaim(
  redis,
  key,
  { otpId, sessionToken, validatedAt },
) {
  const res = await redis.eval(
    RELEASE_VALIDATED_SESSION_CLAIM_LUA,
    1,
    key,
    otpId ? String(otpId) : "",
    String(sessionToken ?? ""),
    validatedAt != null ? String(validatedAt) : "",
  );
  if (!Array.isArray(res) || !res.length) return { status: "error" };
  const status = res[0];
  if (status === "ok") return { status: "ok" };
  if (status === "gone") return { status: "gone" };
  if (status === "noop") return { status: "noop" };
  return { status: String(status) };
}

export async function rollbackValidatedAtomic(redis, key, { otpId, validatedAt, sessionToken }) {
  const res = await redis.eval(
    ROLLBACK_VALIDATED_LUA,
    1,
    key,
    otpId ? String(otpId) : "",
    validatedAt != null ? String(validatedAt) : "",
    sessionToken != null && sessionToken !== false ? String(sessionToken) : "",
  );
  if (!Array.isArray(res) || !res.length) return { status: "error" };
  const status = res[0];
  if (status === "ok") return { status: "ok" };
  if (status === "gone") return { status: "gone" };
  if (status === "noop") return { status: "noop" };
  return { status: String(status) };
}

export async function reserveOtpSendSlotAtomic(
  redis,
  key,
  { cooldownSec, leaseMs, nowMs },
) {
  const res = await redis.eval(
    RESERVE_OTP_SEND_LUA,
    1,
    key,
    String(cooldownSec ?? 0),
    String(leaseMs ?? 30_000),
    String(nowMs ?? Date.now()),
  );
  if (!Array.isArray(res) || !res.length) return { status: "error" };
  const status = res[0];
  if (status === "ok" && res[1] === "no_key") return { status: "no_challenge" };
  if (status === "ok") return { status: "ok", sendClaimUntilMs: res[1] != null && res[1] !== "no_key" ? Number(res[1]) : undefined };
  if (status === "cooldown") return { status: "cooldown", waitSec: Number(res[1]) };
  if (status === "inflight") return { status: "inflight" };
  return { status: String(status) };
}

export async function clearOtpSendClaimAtomic(redis, key, { sendClaimUntilMs, nowMs }) {
  const res = await redis.eval(
    CLEAR_OTP_SEND_CLAIM_LUA,
    1,
    key,
    sendClaimUntilMs != null ? String(sendClaimUntilMs) : "",
    String(nowMs ?? Date.now()),
  );
  if (!Array.isArray(res) || !res.length) return { status: "error" };
  const status = res[0];
  if (status === "ok") return { status: "ok" };
  if (status === "gone") return { status: "gone" };
  if (status === "claim_mismatch") return { status: "claim_mismatch" };
  if (status === "claim_expired") return { status: "claim_expired" };
  return { status: String(status) };
}

export async function deleteChallengeIfOtpId(redis, key, otpId) {
  const res = await redis.eval(DELETE_IF_OTPID_LUA, 1, key, otpId);
  return normalizeVerifyResult(res);
}

export async function claimMessageCentralVerify(redis, key, { otpId, verificationId, nowMs, leaseMs }) {
  const res = await redis.eval(
    CLAIM_MC_LUA,
    1,
    key,
    otpId,
    verificationId ?? "",
    String(nowMs),
    String(leaseMs),
  );
  return normalizeMcClaimResult(res);
}

export async function completeMessageCentralVerify(redis, key, { otpId, verificationId, claimUntilMs, nowMs }) {
  const res = await redis.eval(
    COMPLETE_MC_LUA,
    1,
    key,
    otpId,
    verificationId,
    String(claimUntilMs),
    String(nowMs),
  );
  return normalizeMcCompleteResult(res);
}

export async function releaseMessageCentralClaim(redis, key, { otpId, claimUntilMs }) {
  const res = await redis.eval(
    RELEASE_MC_CLAIM_LUA,
    1,
    key,
    otpId,
    String(claimUntilMs ?? 0),
  );
  if (!Array.isArray(res) || !res.length) return { status: "error" };
  const status = res[0];
  if (status === "ok") return { status: "ok" };
  if (status === "gone") return { status: "gone" };
  if (status === "otpId_mismatch") return { status: "otp_id_mismatch" };
  if (status === "claim_mismatch") return { status: "claim_mismatch", claimUntilMs: Number(res[1]) };
  return { status: String(status) };
}

export async function finalizeMessageCentralValidated(redis, key, {
  otpId,
  verificationId,
  claimUntilMs,
  nowMs,
}) {
  const res = await redis.eval(
    FINALIZE_MC_VALIDATED_LUA,
    1,
    key,
    otpId ? String(otpId) : "",
    verificationId ?? "",
    String(claimUntilMs ?? 0),
    String(nowMs),
  );
  if (!Array.isArray(res) || !res.length) return { status: "error" };
  const status = res[0];
  if (status === "ok") return { status: "ok", validatedAt: res[1] != null ? Number(res[1]) : undefined };
  if (status === "gone") return { status: "gone" };
  if (status === "otpId_mismatch") return { status: "otp_id_mismatch" };
  if (status === "vid_mismatch") return { status: "vid_mismatch" };
  if (status === "claim_mismatch") return { status: "claim_mismatch", claimUntilMs: Number(res[1]) };
  if (status === "claim_expired") return { status: "claim_expired" };
  if (status === "wrong_provider") return { status: "wrong_provider" };
  return { status: String(status) };
}

function normalizeVerifyResult(res) {
  if (!Array.isArray(res) || !res.length) return { status: "error" };
  const status = res[0];
  if (status === "ok") return { status: "ok", validatedAt: res[1] != null ? Number(res[1]) : undefined };
  if (status === "bad") return { status: "bad", attempts: Number(res[1]) };
  if (status === "gone") return { status: "gone" };
  if (status === "otpId_mismatch") return { status: "otp_id_mismatch" };
  if (status === "expired") return { status: "expired" };
  if (status === "locked") return { status: "locked", attempts: Number(res[1]) };
  if (status === "wrong_provider") return { status: "wrong_provider" };
  if (status === "reuse") return { status: "reuse" };
  if (status === "not_validated") return { status: "not_validated" };
  if (status === "not_claimed") return { status: "not_claimed" };
  if (status === "claim_token_mismatch") return { status: "claim_token_mismatch" };
  if (status === "claim_expired") return { status: "claim_expired" };
  if (status === "bad_token") return { status: "bad_token" };
  return { status: String(status) };
}

function normalizeSessionClaimResult(res) {
  if (!Array.isArray(res) || !res.length) return { status: "error" };
  const status = res[0];
  if (status === "ok") return { status: "ok", validatedAt: res[1] != null ? Number(res[1]) : undefined };
  if (status === "claimed") return { status: "claimed" };
  if (status === "gone") return { status: "gone" };
  if (status === "otpId_mismatch") return { status: "otp_id_mismatch" };
  if (status === "not_validated") return { status: "not_validated" };
  return { status: String(status) };
}

function normalizeMcClaimResult(res) {
  if (!Array.isArray(res) || !res.length) return { status: "error" };
  const status = res[0];
  if (status === "ok") return { status: "ok", claimUntilMs: Number(res[1]) };
  if (status === "claimed") return { status: "claimed", claimUntilMs: Number(res[1]) };
  if (status === "gone") return { status: "gone" };
  if (status === "otpId_mismatch") return { status: "otp_id_mismatch" };
  if (status === "expired") return { status: "expired" };
  if (status === "vid_mismatch") return { status: "vid_mismatch" };
  if (status === "wrong_provider") return { status: "wrong_provider" };
  return { status: String(status) };
}

function normalizeMcCompleteResult(res) {
  if (!Array.isArray(res) || !res.length) return { status: "error" };
  const status = res[0];
  if (status === "ok") return { status: "ok", validatedAt: res[1] != null ? Number(res[1]) : undefined };
  if (status === "gone") return { status: "gone" };
  if (status === "otpId_mismatch") return { status: "otp_id_mismatch" };
  if (status === "vid_mismatch") return { status: "vid_mismatch" };
  if (status === "claim_mismatch") return { status: "claim_mismatch", claimUntilMs: Number(res[1]) };
  if (status === "claim_expired") return { status: "claim_expired" };
  if (status === "wrong_provider") return { status: "wrong_provider" };
  return { status: String(status) };
}

export async function writeChallengeJson(redis, key, record, ttlSeconds) {
  const payload = {
    ...record,
    sendClaimUntilMs: undefined,
    expiresAt: record.expiresAt ?? Date.now() + ttlSeconds * 1000,
    maxAttempts: record.maxAttempts ?? env.OTP_MAX_ATTEMPTS,
  };
  await redis.set(key, JSON.stringify(payload), "EX", ttlSeconds);
}

export async function deleteChallenge(redis, key) {
  await redis.del(key);
}

/** Serialize concurrent sends when no challenge row exists yet (pair with releaseOtpSendGate). */
export async function acquireOtpSendGate(redis, gateKey, leaseMs) {
  const ok = await redis.set(gateKey, "1", "PX", leaseMs, "NX");
  return { ok: ok === "OK" };
}

export async function releaseOtpSendGate(redis, gateKey) {
  try {
    await redis.del(gateKey);
  } catch {
    /* ignore */
  }
}

export function otpRedisClientOrThrow(sourceEnv = env) {
  if (!redisReady()) {
    if (sourceEnv.NODE_ENV === "production") {
      throw new Error("Redis is required for OTP in production.");
    }
    return null;
  }
  return getRedis();
}

export { sha256 as otpSha256 };
