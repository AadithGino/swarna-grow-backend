import { GoogleAuth } from "google-auth-library";
import { env, fcmEnvConfigured } from "../config/env.js";
import { sha256 } from "./crypto.js";
import { unseal } from "./crypto.js";
import { logger } from "../config/logger.js";

const AUTH_CACHE_MAX = 50;
/** @type {Map<string, { auth: GoogleAuth, projectId: string }>} */
const authCache = new Map();

function parseServiceAccountJson(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed?.client_email || !parsed?.private_key) return null;
    return parsed;
  } catch {
    return null;
  }
}

function tenantFcmBucket(tenant) {
  return tenant?.integrationSecrets?.fcm ?? null;
}

export function fcmCredentialFingerprint(projectId, credentials) {
  return sha256(`${projectId}:${credentials.client_email}:${credentials.private_key.slice(0, 32)}`);
}

export function invalidateFcmAuthCache(tenantId) {
  for (const key of [...authCache.keys()]) {
    if (key.startsWith(`${tenantId}:`)) authCache.delete(key);
  }
}

function cacheAuth(cacheKey, projectId, credentials) {
  if (authCache.size >= AUTH_CACHE_MAX) {
    const oldest = authCache.keys().next().value;
    authCache.delete(oldest);
  }
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
  });
  authCache.set(cacheKey, { auth, projectId });
  return authCache.get(cacheKey);
}

function getCachedAuth(cacheKey, projectId, credentials) {
  const hit = authCache.get(cacheKey);
  if (hit) return hit;
  return cacheAuth(cacheKey, projectId, credentials);
}

/**
 * Resolve Firebase project + credentials for a tenant. Never falls back across tenants.
 * @returns {{ source: "tenant"|"platform", projectId: string, credentials: object, cacheKey: string } | null}
 */
export function resolveFcmConfigForTenant(tenant) {
  const bucket = tenantFcmBucket(tenant);
  const tenantProjectId = bucket?.projectId?.trim();
  const tenantSealed = bucket?.serviceAccountJsonSealed;
  if (tenantProjectId && tenantSealed) {
    const credentials = parseServiceAccountJson(unseal(tenantSealed));
    if (credentials) {
      const version = bucket.credentialVersion ?? 1;
      const cacheKey = `${tenant._id ?? tenant.id}:tenant:${version}:${fcmCredentialFingerprint(tenantProjectId, credentials)}`;
      return {
        source: "tenant",
        projectId: tenantProjectId,
        credentials,
        cacheKey,
      };
    }
    logger.warn({ tenantId: tenant._id }, "Tenant FCM credentials could not be parsed");
    return null;
  }

  if (env.FCM_SHARED_PROJECT_ENABLED && fcmEnvConfigured(env)) {
    const credentials = parseServiceAccountJson(env.FCM_SERVICE_ACCOUNT_JSON);
    if (credentials && env.FCM_PROJECT_ID?.trim()) {
      const cacheKey = `platform:shared:${fcmCredentialFingerprint(env.FCM_PROJECT_ID, credentials)}`;
      return {
        source: "platform",
        projectId: env.FCM_PROJECT_ID.trim(),
        credentials,
        cacheKey,
      };
    }
  }

  return null;
}

export async function getFcmAccessToken(fcmConfig) {
  if (!fcmConfig) return null;
  const { auth } = getCachedAuth(fcmConfig.cacheKey, fcmConfig.projectId, fcmConfig.credentials);
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  return tokenResponse?.token ?? null;
}

/** Test helper */
export function clearFcmAuthCacheForTests() {
  authCache.clear();
}
