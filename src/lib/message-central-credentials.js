import { env } from "../config/env.js";
import { unseal } from "./crypto.js";
import { fetchMessageCentralAuthToken } from "../integrations/message-central.client.js";
import { Tenant } from "../models/index.js";

const tokenCache = new Map();

function cacheKey(tenantId, credentialVersion) {
  return `${tenantId}:${credentialVersion ?? 1}`;
}

export function invalidateMessageCentralAuthCache(tenantId) {
  for (const key of tokenCache.keys()) {
    if (key.startsWith(`${tenantId}:`)) tokenCache.delete(key);
  }
}

function readLegacyPlainJwtKey(keySealed) {
  const raw = String(keySealed ?? "");
  if (raw.startsWith("eyJ")) return raw;
  return null;
}

function unsealSecret(sealed) {
  if (!sealed) return null;
  const legacyJwt = readLegacyPlainJwtKey(sealed);
  if (legacyJwt) return legacyJwt;
  return unseal(sealed);
}

export function resolveMessageCentralBucket(tenant) {
  const bucket = tenant?.integrationSecrets?.messageCentral;
  if (!bucket?.customerId) return null;
  const authToken = bucket.authTokenSealed
    ? unsealSecret(bucket.authTokenSealed)
    : readLegacyPlainJwtKey(bucket.keySealed);
  const key = bucket.keySealed && !readLegacyPlainJwtKey(bucket.keySealed)
    ? unsealSecret(bucket.keySealed)
    : null;
  if (!authToken && !key) return null;
  return {
    customerId: bucket.customerId,
    key: key ?? "",
    authToken: authToken ?? null,
    email: bucket.email ?? "",
    countryCode: bucket.countryCode ?? "91",
    flowType: bucket.flowType ?? "SMS",
    otpLength: Number(bucket.otpLength ?? 6),
    credentialVersion: Number(bucket.credentialVersion ?? 1),
    verifiedAt: bucket.verifiedAt ?? null,
  };
}

export async function loadTenantMessageCentralCredentials(tenantId) {
  const tenant = await Tenant.findById(tenantId).select("+integrationSecrets").lean();
  return resolveMessageCentralBucket(tenant);
}

export async function getMessageCentralAuthToken(credentials, tenantId, deps = {}) {
  if (!credentials) {
    throw new Error("Message Central credentials are not configured.");
  }
  if (credentials.authToken) {
    return credentials.authToken;
  }
  const key = cacheKey(tenantId, credentials.credentialVersion);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.authToken;
  }
  const { authToken } = await fetchMessageCentralAuthToken(credentials, deps);
  tokenCache.set(key, { authToken, expiresAt: Date.now() + (50 * 60 * 1000) });
  return authToken;
}

export function messageCentralConfiguredForOtp(credentials) {
  if (!credentials?.customerId) return false;
  if (credentials.platformScope) {
    return Boolean(credentials.authToken || credentials.key);
  }
  if (!credentials?.verifiedAt) return false;
  if (credentials.authToken) return true;
  return Boolean(credentials.key && credentials.email);
}

/** Platform-scoped credentials for merchant signup before a tenant exists. */
export function loadPlatformMessageCentralCredentials(source = env) {
  const customerId = String(
    source.MESSAGE_CENTRAL_PLATFORM_CUSTOMER_ID
      ?? source.MESSAGE_CENTRAL_CUSTOMER_ID
      ?? "",
  ).trim();
  const authToken = String(
    source.MESSAGE_CENTRAL_PLATFORM_AUTH_TOKEN
      ?? source.MESSAGE_CENTRAL_AUTH_TOKEN
      ?? "",
  ).trim();
  const key = String(source.MESSAGE_CENTRAL_PLATFORM_KEY ?? "").trim();
  if (!customerId || (!authToken && !key)) return null;
  return {
    customerId,
    key,
    authToken: authToken || null,
    email: String(
      source.MESSAGE_CENTRAL_PLATFORM_EMAIL
        ?? source.MESSAGE_CENTRAL_EMAIL
        ?? "",
    ).trim(),
    countryCode: String(
      source.MESSAGE_CENTRAL_PLATFORM_COUNTRY_CODE
        ?? source.MESSAGE_CENTRAL_COUNTRY_CODE
        ?? "91",
    ).replace(/\D/g, "") || "91",
    flowType: "SMS",
    otpLength: Number(
      source.MESSAGE_CENTRAL_PLATFORM_OTP_LENGTH
        ?? source.MESSAGE_CENTRAL_OTP_LENGTH
        ?? 6,
    ),
    credentialVersion: 1,
    verifiedAt: new Date(0),
    platformScope: true,
  };
}

