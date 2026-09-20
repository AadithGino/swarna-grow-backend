import { Alert } from "../models/index.js";

/** Critical review alert for completed webhooks that fail strict provider field validation. */
export async function upsertGatewayWebhookInvalidCompletedAlert({
  tenantId,
  entityId,
  code,
  reference = null,
  webhookEventId,
}) {
  await Alert.findOneAndUpdate(
    {
      tenantId,
      type: "GATEWAY_WEBHOOK_INVALID_COMPLETED",
      entityId,
      status: "OPEN",
    },
    {
      $setOnInsert: {
        severity: "CRITICAL",
        title: "Invalid completed gateway webhook",
        message: `Completed PhonePe callback rejected before finalization: ${code}`,
        entityType: "WEBHOOK",
        metadata: {
          code,
          reference: reference ?? null,
          webhookEventId,
        },
      },
    },
    { upsert: true },
  );
}
