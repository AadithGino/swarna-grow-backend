import { AppError } from "../lib/app-error.js";
import { env } from "../config/env.js";

export const MESSAGE_CENTRAL_DEFAULT_BASE = "https://cpaas.messagecentral.com";

export function messageCentralBaseUrl(cfg = env) {
  const raw = cfg.MESSAGE_CENTRAL_BASE_URL || MESSAGE_CENTRAL_DEFAULT_BASE;
  return String(raw).replace(/\/$/, "");
}

/** MC send API expects national mobile digits without country prefix. */
export function toMessageCentralMobile(mobile, countryCode = "91") {
  const digits = String(mobile ?? "").replace(/\D/g, "");
  const cc = String(countryCode ?? "91").replace(/\D/g, "");
  if (cc !== "91") throw new AppError("OTP_COUNTRY_UNSUPPORTED", "SMS verification supports Indian mobile numbers only.", 422);
  const national = digits.startsWith("91") && digits.length === 12 ? digits.slice(2) : digits;
  if (!/^[6-9]\d{9}$/.test(national)) throw new AppError("MOBILE_INVALID", "Enter a valid Indian mobile number.", 422);
  return national;
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function authTokenFromBody(parsed) {
  return parsed?.token ?? parsed?.data?.authToken ?? parsed?.data?.token ?? null;
}

export async function fetchMessageCentralAuthToken(credentials, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const cfg = deps.env ?? env;
  const timeoutMs = cfg.MESSAGE_CENTRAL_TIMEOUT_MS || 8000;
  const {
    customerId,
    key,
    email,
    countryCode = "91",
    scope = "NEW",
  } = credentials;
  const params = new URLSearchParams({
    customerId: String(customerId),
    key: String(key),
    scope,
    country: String(countryCode).replace(/\D/g, ""),
    email: String(email ?? ""),
  });
  const url = `${messageCentralBaseUrl(cfg)}/auth/v1/authentication/token?${params}`;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "*/*" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  const parsed = parseJson(text);
  const token = authTokenFromBody(parsed);
  if (!res.ok || !token) {
    throw new Error(
      `Message Central auth failed: ${parsed?.message || parsed?.raw || `HTTP ${res.status}`}`,
    );
  }
  return { authToken: token, raw: parsed };
}

export async function sendMessageCentralOtp(
  { authToken, mobile, countryCode = "91", flowType = "SMS", otpLength = 6 },
  deps = {},
) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const cfg = deps.env ?? env;
  const timeoutMs = cfg.MESSAGE_CENTRAL_TIMEOUT_MS || 8000;
  const mobileNumber = toMessageCentralMobile(mobile, countryCode);
  const params = new URLSearchParams({
    countryCode: String(countryCode).replace(/\D/g, ""),
    flowType,
    mobileNumber,
    otpLength: String(otpLength),
  });
  const url = `${messageCentralBaseUrl(cfg)}/verification/v3/send?${params}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { authToken: String(authToken), accept: "*/*" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  const parsed = parseJson(text);
  const verificationId = parsed?.data?.verificationId ?? parsed?.verificationId ?? null;
  const ok = res.ok && verificationId
    && (parsed?.responseCode === 200 || parsed?.message === "SUCCESS" || parsed?.status === 200);
  if (!ok) {
    throw new Error(
      `Message Central send failed: ${parsed?.message || parsed?.data?.errorMessage || parsed?.raw || `HTTP ${res.status}`}`,
    );
  }
  return { verificationId: String(verificationId), raw: parsed };
}

export async function validateMessageCentralOtp(
  { authToken, verificationId, code },
  deps = {},
) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const cfg = deps.env ?? env;
  const timeoutMs = cfg.MESSAGE_CENTRAL_TIMEOUT_MS || 8000;
  const params = new URLSearchParams({
    verificationId: String(verificationId),
    code: String(code ?? "").trim(),
  });
  const url = `${messageCentralBaseUrl(cfg)}/verification/v3/validateOtp?${params}`;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { authToken: String(authToken), accept: "*/*" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  const parsed = parseJson(text);
  const status = parsed?.data?.verificationStatus ?? parsed?.verificationStatus ?? null;
  const ok = res.ok && status === "VERIFICATION_COMPLETED";
  return { ok, raw: parsed, verificationStatus: status };
}
