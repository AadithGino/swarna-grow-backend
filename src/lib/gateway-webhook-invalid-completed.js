import { AlertType } from "../constants/enums.js";
import { upsertOperationalAlert } from "./operational-alert.js";

/** Critical review alert for completed webhooks that fail strict provider field validation. */
export async function upsertGatewayWebhookInvalidCompletedAlert({
  tenantId,
  entityId,
  code,
  reference = null,
  webhookEventId,
}) {
  await upsertOperationalAlert({
    tenantId,
    type: AlertType.GATEWAY_WEBHOOK_INVALID_COMPLETED,
    entityId,
    title: "Invalid completed gateway webhook",
    message: `Completed PhonePe callback rejected before finalization: ${code}`,
    metadata: {
      code,
      reference: reference ?? null,
      webhookEventId,
    },
  });
}
