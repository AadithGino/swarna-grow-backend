import { AlertType, JobStatus } from "../constants/enums.js";
import { callbackTypeKey } from "../integrations/phonepe.provider.js";
import { upsertOperationalAlert } from "../lib/operational-alert.js";
import { incrementOpsMetric, OpsMetric } from "../lib/ops-metrics.js";
import { logger } from "../config/logger.js";
import { WebhookEvent } from "../models/index.js";

function sanitizeCallbackMetadata(type, payload) {
  const typeKey = type == null ? null : callbackTypeKey(type);
  return {
    callbackType: typeKey,
    hasPayload: Boolean(payload && typeof payload === "object"),
    reference:
      payload?.originalMerchantOrderId
      ?? payload?.merchantOrderId
      ?? payload?.orderId
      ?? null,
  };
}

/**
 * Terminal handling for PhonePe callbacks we do not recognize — no financial writes.
 */
export async function finalizeUnsupportedPhonePeCallback({
  tenantId,
  webhookEventId,
  providerEventId,
  type,
  payload = {},
}) {
  const metadata = sanitizeCallbackMetadata(type, payload);
  const terminal = await WebhookEvent.updateOne(
    {
      _id: webhookEventId,
      tenantId,
      status: { $nin: [JobStatus.COMPLETED, JobStatus.UNSUPPORTED] },
    },
    {
      $set: {
        status: JobStatus.UNSUPPORTED,
        processedAt: new Date(),
        unsupportedCallbackType: metadata.callbackType,
        unsupportedMetadata: metadata,
        error: "UNSUPPORTED_CALLBACK",
      },
    },
  );
  if (!terminal.modifiedCount) {
    return { outcome: "ALREADY_TERMINAL" };
  }
  await upsertOperationalAlert({
    tenantId,
    type: AlertType.GATEWAY_UNSUPPORTED_CALLBACK,
    entityId: providerEventId ?? webhookEventId,
    title: "Unsupported PhonePe callback",
    message: "A verified PhonePe webhook used an unsupported callback type and was not applied to payments.",
    metadata: { ...metadata, webhookEventId },
  });
  incrementOpsMetric(OpsMetric.PHONEPE_WEBHOOK_UNSUPPORTED, 1);
  logger.warn(
    { tenantId, webhookEventId, providerEventId, ...metadata },
    "PhonePe unsupported callback — no financial mutation",
  );
  return { outcome: "UNSUPPORTED" };
}
