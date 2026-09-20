/** @typedef {"SUCCESS"|"PERMANENT_INVALID_TOKEN"|"PERMANENT_PAYLOAD_ERROR"|"TRANSIENT"|"RATE_LIMITED"} PushOutcomeKind */

export const PushOutcomeKind = Object.freeze({
  SUCCESS: "SUCCESS",
  PERMANENT_INVALID_TOKEN: "PERMANENT_INVALID_TOKEN",
  PERMANENT_PAYLOAD_ERROR: "PERMANENT_PAYLOAD_ERROR",
  TRANSIENT: "TRANSIENT",
  RATE_LIMITED: "RATE_LIMITED",
});

function fcmErrorDetails(errorBody) {
  return Array.isArray(errorBody?.error?.details) ? errorBody.error.details : [];
}

function detailErrorCodes(errorBody) {
  return fcmErrorDetails(errorBody)
    .map((row) => row?.errorCode)
    .filter(Boolean);
}

/**
 * Classify FCM HTTP v1 send failures. Only UNREGISTERED (or equivalent token detail) prunes tokens.
 * @returns {PushOutcomeKind}
 */
export function classifyFcmHttpFailure(httpStatus, errorBody) {
  const codes = detailErrorCodes(errorBody);
  const statusName = String(errorBody?.error?.status ?? "");

  if (codes.includes("UNREGISTERED") || statusName === "UNREGISTERED") {
    return PushOutcomeKind.PERMANENT_INVALID_TOKEN;
  }

  if (httpStatus === 408 || httpStatus === 429) return PushOutcomeKind.TRANSIENT;
  if (httpStatus >= 500 && httpStatus < 600) return PushOutcomeKind.TRANSIENT;

  if (httpStatus === 401 || httpStatus === 403) return PushOutcomeKind.PERMANENT_PAYLOAD_ERROR;
  if (codes.includes("INVALID_ARGUMENT") || statusName === "INVALID_ARGUMENT") {
    return PushOutcomeKind.PERMANENT_PAYLOAD_ERROR;
  }
  if (statusName === "NOT_FOUND" && !codes.includes("UNREGISTERED")) {
    return PushOutcomeKind.PERMANENT_PAYLOAD_ERROR;
  }

  if (httpStatus >= 400 && httpStatus < 500) return PushOutcomeKind.PERMANENT_PAYLOAD_ERROR;
  return PushOutcomeKind.TRANSIENT;
}

export function parseRetryAfterMs(response) {
  const header = response.headers?.get?.("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 300_000);
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) return Math.max(0, Math.min(dateMs - Date.now(), 300_000));
  return null;
}

export function retryDelayMs(attempt, baseMs, retryAfterMs) {
  if (retryAfterMs != null) return retryAfterMs;
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * Math.min(baseMs, 250));
  return Math.min(exp + jitter, 60_000);
}
