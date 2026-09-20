import { env } from "../config/env.js";

export function fcmCredentialsConfigured() {
  const projectId = env.FCM_PROJECT_ID?.trim();
  const raw = env.FCM_SERVICE_ACCOUNT_JSON?.trim();
  if (!projectId || !raw) return false;
  try {
    const parsed = JSON.parse(raw);
    return Boolean(parsed?.client_email && parsed?.private_key);
  } catch {
    return false;
  }
}

export function getProviderConfigurationStatus() {
  return {
    providerMode: env.PROVIDER_MODE,
    rateLimiting: env.RATE_LIMIT_ENABLED ? "enabled" : "disabled",
    redisRequired: env.REDIS_REQUIRED ? "required" : "optional",
    fcm: fcmCredentialsConfigured() ? "configured" : "not-configured",
    s3: env.S3_BUCKET?.trim() ? "configured" : "not-configured",
    malwareScan: env.MALWARE_SCAN_URL ? "configured" : "not-configured",
    phonepePlatformEnvironment: env.PHONEPE_ENV,
  };
}
