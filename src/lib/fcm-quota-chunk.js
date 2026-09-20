import { env } from "../config/env.js";

const FCM_HTTP_BATCH_CAP = 500;

export function fcmLimiterBurstCaps() {
  const globalBurst = Math.max(1, env.FCM_RATE_LIMIT_GLOBAL_BURST ?? 400);
  const tenantBurst = Math.max(1, env.FCM_RATE_LIMIT_TENANT_BURST ?? 160);
  return { globalBurst, tenantBurst };
}

/** Max devices per limiter acquisition and HTTP v1 send wave (not Firebase multicast). */
export function effectiveFcmSendChunkSize() {
  const configuredBatch = Math.max(1, Math.min(FCM_HTTP_BATCH_CAP, env.FCM_MULTICAST_BATCH_SIZE ?? 500));
  const { globalBurst, tenantBurst } = fcmLimiterBurstCaps();
  return Math.max(1, Math.min(configuredBatch, globalBurst, tenantBurst));
}

export function assertFcmQuotaConfiguration() {
  const chunk = effectiveFcmSendChunkSize();
  if (chunk < 1) {
    throw new Error("FCM quota configuration is invalid: effective send chunk size must be at least 1");
  }
  const batch = env.FCM_MULTICAST_BATCH_SIZE ?? 500;
  if (batch < 1 || batch > FCM_HTTP_BATCH_CAP) {
    throw new Error(`FCM_MULTICAST_BATCH_SIZE must be between 1 and ${FCM_HTTP_BATCH_CAP}`);
  }
}
