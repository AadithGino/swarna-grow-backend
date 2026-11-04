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

export function resolveMessageCentralBucket(tenant) {
  const bucket = tenant?.integrationSecrets?.messageCentral;
  if (!bucket?.customerId || !bucket?.keySealed) return null;
  return {
    customerId: bucket.customerId,
    key: unseal(bucket.keySealed),
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
  return Boolean(credentials?.customerId && credentials?.key && credentials?.verifiedAt);
}

/** Platform-scoped credentials for merchant signup before a tenant exists. */
export function loadPlatformMessageCentralCredentials(source = env) {
  const customerId = String(source.MESSAGE_CENTRAL_PLATFORM_CUSTOMER_ID ?? "").trim();
  const key = String(source.MESSAGE_CENTRAL_PLATFORM_KEY ?? "").trim();
  if (!customerId || !key) return null;
  return {
    customerId,
    key,
    email: String(source.MESSAGE_CENTRAL_PLATFORM_EMAIL ?? "").trim(),
    countryCode: String(source.MESSAGE_CENTRAL_PLATFORM_COUNTRY_CODE ?? "91").replace(/\D/g, "") || "91",
    flowType: "SMS",
    otpLength: Number(source.MESSAGE_CENTRAL_PLATFORM_OTP_LENGTH ?? 6),
    credentialVersion: 1,
    verifiedAt: new Date(0),
    platformScope: true,
  };
}
