import {
  DIGITAL_METAL_OUTBOX_TOPICS,
  enqueueDigitalMetalOutboxEvent,
} from "./digital-metals-outbox.js";

export function digitalMetalInboxEventKey(kind, entityId, transition) {
  const base = `digital_metal.${kind}:${entityId}`;
  return transition ? `${base}:${transition}` : base;
}

export function tenantCodeToCustomerSlug(code) {
  return String(code ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
}

export { digitalMetalCustomerDeepLink } from "./digital-metals-customer-deep-links.js";

export async function enqueuePurchaseCreditedNotice(session, { tenantId, orderId, customerId }) {
  await enqueueDigitalMetalOutboxEvent({
    tenantId,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_CREDITED,
    key: orderId,
    payload: { orderId, customerId },
    session,
  });
}

export async function enqueuePurchasePaymentFailedNotice(session, { tenantId, orderId, customerId, reason }) {
  await enqueueDigitalMetalOutboxEvent({
    tenantId,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_PAYMENT_FAILED,
    key: `${orderId}:payment-failed`,
    payload: { orderId, customerId, reason: reason ?? "FAILED" },
    session,
  });
}

export async function enqueueSellExecutedNotice(session, { tenantId, orderId, customerId, eventAt }) {
  await enqueueDigitalMetalOutboxEvent({
    tenantId,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.SELL_EXECUTED,
    key: orderId,
    payload: {
      orderId,
      customerId,
      eventAt: (eventAt ?? new Date()).toISOString(),
    },
    session,
  });
}

export async function enqueuePayoutCustomerNotice(session, {
  tenantId,
  payoutId,
  customerId,
  transition,
  eventAt,
}) {
  await enqueueDigitalMetalOutboxEvent({
    tenantId,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.PAYOUT_CUSTOMER_NOTICE,
    key: `${payoutId}:${transition}`,
    payload: {
      payoutId,
      customerId,
      transition,
      eventAt: (eventAt ?? new Date()).toISOString(),
    },
    session,
  });
}

export async function enqueueRedemptionCustomerNotice(session, {
  tenantId,
  orderId,
  customerId,
  transition,
  eventAt,
  shipmentEventId,
}) {
  const key = shipmentEventId
    ? `${orderId}:${transition}:${shipmentEventId}`
    : `${orderId}:${transition}`;
  await enqueueDigitalMetalOutboxEvent({
    tenantId,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.REDEMPTION_CUSTOMER_NOTICE,
    key,
    payload: {
      orderId,
      customerId,
      transition,
      eventAt: (eventAt ?? new Date()).toISOString(),
      ...(shipmentEventId ? { shipmentEventId } : {}),
    },
    session,
  });
}

export async function enqueueDocumentReadyNotice({ tenantId, artifactId, customerId, session }) {
  return enqueueDigitalMetalOutboxEvent({
    tenantId,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.DOCUMENT_READY,
    key: `${artifactId}:ready`,
    payload: { artifactId, customerId },
    session,
  });
}
