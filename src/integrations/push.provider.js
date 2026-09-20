import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { getFcmAccessToken, resolveFcmConfigForTenant } from "../lib/fcm-config.js";
import { buildFcmV1Message } from "../lib/fcm-message-build.js";
import { FcmSendDeferredError } from "../lib/fcm-push-errors.js";
import { acquireFcmSendQuota } from "../lib/fcm-redis-limiter.js";
import { effectiveFcmSendChunkSize } from "../lib/fcm-quota-chunk.js";
import {
  PushOutcomeKind,
  classifyFcmHttpFailure,
  parseRetryAfterMs,
  retryDelayMs,
} from "../lib/fcm-outcomes.js";
import { FcmSharedMetric, incrementSharedFcmMetric } from "../lib/fcm-redis-metrics.js";
import { incrementOpsMetric, observeOpsDuration, OpsMetric, recordFcmOutcomes } from "../lib/ops-metrics.js";

function recordSharedFcmOutcomes(outcomes = []) {
  for (const row of outcomes) {
    if (row.kind === PushOutcomeKind.SUCCESS) {
      void incrementSharedFcmMetric(FcmSharedMetric.DELIVERY_SUCCEEDED);
    } else if (row.kind === PushOutcomeKind.TRANSIENT || row.kind === PushOutcomeKind.RATE_LIMITED) {
      void incrementSharedFcmMetric(FcmSharedMetric.DELIVERY_TRANSIENT);
    } else if (row.kind === PushOutcomeKind.PERMANENT_INVALID_TOKEN
      || row.kind === PushOutcomeKind.PERMANENT_PAYLOAD_ERROR) {
      void incrementSharedFcmMetric(FcmSharedMetric.DELIVERY_PERMANENT);
    }
  }
}

/** @internal Allows tests to stub OAuth without loading Google credentials. */
export const pushProviderTestHooks = {
  accessTokenProvider: null,
  forceLive: false,
  /** @type {null | ((args: object) => Promise<object>)} */
  sendOverride: null,
};

function multicastBatchSize() {
  return effectiveFcmSendChunkSize();
}

function dedupeDevices(devices) {
  const seen = new Set();
  const out = [];
  for (const device of devices) {
    const key = device.deviceRegistrationId
      ?? device.tokenHash
      ?? device.token;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(device);
  }
  return out;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function sendOneAttempt({
  projectId,
  accessToken,
  messageBody,
  timeoutMs,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: messageBody }),
        signal: controller.signal,
      },
    );
    if (response.ok) {
      const payload = await response.json().catch(() => ({}));
      return {
        kind: PushOutcomeKind.SUCCESS,
        providerMessageId: payload.name ?? null,
      };
    }
    const payload = await response.json().catch(() => ({}));
    const kind = classifyFcmHttpFailure(response.status, payload);
    return {
      kind,
      httpStatus: response.status,
      errorCode: payload?.error?.status ?? String(response.status),
      retryAfterMs: kind === PushOutcomeKind.TRANSIENT
        ? parseRetryAfterMs(response)
        : null,
    };
  } catch (error) {
    const aborted = error?.name === "AbortError";
    return {
      kind: PushOutcomeKind.TRANSIENT,
      errorCode: aborted ? "TIMEOUT" : "NETWORK",
      retryAfterMs: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function sendToDeviceOnce({
  fcmConfig,
  accessToken,
  messageBody,
  attempt = 1,
}) {
  const result = await sendOneAttempt({
    projectId: fcmConfig.projectId,
    accessToken,
    messageBody,
    timeoutMs: env.FCM_REQUEST_TIMEOUT_MS ?? 15_000,
  });
  return { ...result, attempt };
}

async function sendLive({
  tenant,
  devices,
  title,
  body,
  data = {},
  imageUrl,
  messageType,
  collapseKey,
  tenantId,
}) {
  const fcmConfig = resolveFcmConfigForTenant(tenant);
  if (!fcmConfig) {
    throw new Error("FCM is not configured for this tenant");
  }
  const accessToken = pushProviderTestHooks.accessTokenProvider
    ? await pushProviderTestHooks.accessTokenProvider(fcmConfig)
    : await getFcmAccessToken(fcmConfig);
  if (!accessToken) {
    throw new Error("FCM access token could not be obtained");
  }

  const deviceList = dedupeDevices(devices);
  const batches = chunkArray(deviceList, multicastBatchSize());
  const concurrency = env.FCM_SEND_CONCURRENCY ?? 32;
  const outcomes = [];
  const started = Date.now();

  for (const batch of batches) {
    incrementOpsMetric(OpsMetric.FCM_SEND_BATCH);
    const quota = await acquireFcmSendQuota({
      tenantId: tenantId ?? tenant._id,
      cost: batch.length,
    });
    if (!quota.allowed) {
      incrementOpsMetric(OpsMetric.FCM_SEND_DEFERRED);
      void incrementSharedFcmMetric(FcmSharedMetric.SEND_DEFERRED);
      throw new FcmSendDeferredError(quota.retryAfterMs, quota.scope ?? "rate_limit");
    }
    void incrementSharedFcmMetric(FcmSharedMetric.SEND_ATTEMPT, batch.length);

    const batchOutcomes = await mapWithConcurrency(batch, concurrency, async (device) => {
      const messageBody = buildFcmV1Message({
        registrationToken: device.token,
        title,
        body,
        data,
        imageUrl,
        messageType,
        collapseKey,
      });
      const result = await sendToDeviceOnce({
        fcmConfig,
        accessToken,
        messageBody,
        attempt: device._deliveryAttempt ?? 1,
      });
      return {
        deviceRegistrationId: device.deviceRegistrationId ?? null,
        tokenHash: device.tokenHash ?? null,
        token: device.token,
        registrationVersion: device.registrationVersion ?? null,
        ...result,
      };
    });
    outcomes.push(...batchOutcomes);
  }

  observeOpsDuration("fcm.send.ms", Date.now() - started);

  let successCount = 0;
  let failureCount = 0;
  const invalidRegistrationIds = [];
  for (const row of outcomes) {
    if (row.kind === PushOutcomeKind.SUCCESS) successCount += 1;
    else {
      failureCount += 1;
      if (row.kind === PushOutcomeKind.PERMANENT_INVALID_TOKEN && row.deviceRegistrationId) {
        invalidRegistrationIds.push({
          id: row.deviceRegistrationId,
          tokenHash: row.tokenHash,
          registrationVersion: row.registrationVersion,
        });
      }
    }
  }

  recordFcmOutcomes(outcomes);
  recordSharedFcmOutcomes(outcomes);

  return {
    outcomes,
    successCount,
    failureCount,
    invalidRegistrationIds,
    invalidTokens: outcomes
      .filter((row) => row.kind === PushOutcomeKind.PERMANENT_INVALID_TOKEN)
      .map((row) => row.token),
  };
}

export const pushProvider = {
  /**
   * @param {{ tenant?: object, tenantId?: string, devices?: object[], tokens?: string[], title: string, body: string, data?: object, imageUrl?: string, messageType?: string, collapseKey?: string }} params
   */
  async send({
    tenant,
    tenantId,
    devices,
    tokens = [],
    title,
    body,
    data,
    imageUrl,
    messageType,
    collapseKey,
  }) {
    if (pushProviderTestHooks.sendOverride) {
      return pushProviderTestHooks.sendOverride({
        tenant,
        tenantId,
        devices,
        tokens,
        title,
        body,
        data,
        imageUrl,
        messageType,
        collapseKey,
      });
    }
    const deviceList = devices?.length
      ? devices
      : [...new Set(tokens.filter(Boolean))].map((token) => ({ token }));
    if (!deviceList.length) {
      return {
        outcomes: [],
        successCount: 0,
        failureCount: 0,
        invalidRegistrationIds: [],
        invalidTokens: [],
      };
    }
    if (env.PROVIDER_MODE === "mock" && !pushProviderTestHooks.forceLive) {
      logger.info({ tokenCount: deviceList.length, title }, "Mock push notification delivered");
      return {
        outcomes: deviceList.map((device) => ({
          deviceRegistrationId: device.deviceRegistrationId ?? null,
          tokenHash: device.tokenHash ?? null,
          token: device.token,
          kind: PushOutcomeKind.SUCCESS,
          providerMessageId: `mock/${String(device.tokenHash ?? device.token).slice(0, 8)}`,
        })),
        successCount: deviceList.length,
        failureCount: 0,
        invalidRegistrationIds: [],
        invalidTokens: [],
      };
    }
    if (!tenant) {
      const message = "tenant context is required for live push delivery";
      if (env.NODE_ENV === "production") throw new Error(message);
      logger.warn({ tokenCount: deviceList.length }, message);
      return {
        outcomes: deviceList.map((device) => ({
          deviceRegistrationId: device.deviceRegistrationId ?? null,
          tokenHash: device.tokenHash ?? null,
          token: device.token,
          kind: PushOutcomeKind.PERMANENT_PAYLOAD_ERROR,
          errorCode: "MISSING_TENANT",
        })),
        successCount: 0,
        failureCount: deviceList.length,
        invalidRegistrationIds: [],
        invalidTokens: [],
      };
    }
    return sendLive({
      tenant,
      tenantId: tenantId ?? tenant._id,
      devices: deviceList,
      title,
      body,
      data,
      imageUrl,
      messageType,
      collapseKey,
    });
  },
};

export { retryDelayMs, dedupeDevices, chunkArray as chunkDevices, multicastBatchSize };
