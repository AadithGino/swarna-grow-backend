import { MessageType } from "../constants/enums.js";

const DEFAULT_TTL_SEC = 86_400;

const HIGH_PRIORITY_TYPES = new Set([
  MessageType.PAYMENT_SUCCESS,
  MessageType.OTP,
]);

export function pushPriorityForMessageType(messageType) {
  return HIGH_PRIORITY_TYPES.has(messageType) ? "high" : "normal";
}

export function buildFcmV1Message({
  registrationToken,
  title,
  body,
  data = {},
  imageUrl,
  messageType,
  ttlSec = DEFAULT_TTL_SEC,
  collapseKey,
}) {
  const priority = pushPriorityForMessageType(messageType);
  const androidPriority = priority === "high" ? "HIGH" : "NORMAL";
  const apnsPriority = priority === "high" ? "10" : "5";
  const expiration = String(Math.floor(Date.now() / 1000) + ttlSec);

  return {
    token: registrationToken,
    notification: {
      title,
      body,
      ...(imageUrl ? { image: imageUrl } : {}),
    },
    data: Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, String(value ?? "")]),
    ),
    android: {
      priority: androidPriority,
      ttl: `${ttlSec}s`,
      ...(collapseKey ? { collapse_key: collapseKey } : {}),
      ...(imageUrl ? { notification: { image: imageUrl } } : {}),
    },
    apns: {
      headers: {
        "apns-priority": apnsPriority,
        "apns-expiration": expiration,
      },
      payload: {
        aps: {
          ...(priority === "high" ? { "content-available": 1 } : {}),
          ...(imageUrl ? { "mutable-content": 1 } : {}),
        },
      },
      ...(imageUrl ? { fcm_options: { image: imageUrl } } : {}),
    },
    webpush: {
      headers: { TTL: String(ttlSec) },
    },
  };
}
