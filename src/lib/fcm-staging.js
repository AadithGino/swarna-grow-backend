/** Synthetic FCM device id prefix — staging runner refuses non-staging registrations. */
export const STAGING_FCM_DEVICE_ID_PREFIX = "staging-fcm-";

export function isStagingFcmDeviceId(deviceId) {
  return String(deviceId ?? "").startsWith(STAGING_FCM_DEVICE_ID_PREFIX);
}
