import { MessageType } from "../constants/enums.js";
import { moneyRef } from "./money.js";
import { DIGITAL_METAL_OUTBOX_TOPICS } from "./digital-metals-outbox.js";
import { digitalMetalInboxEventKey } from "./digital-metals-customer-notice.js";
import {
  deepLinkBuyOrder,
  deepLinkDigitalMetalsHome,
  deepLinkDocumentArtifact,
  deepLinkRedemptionOrder,
  deepLinkSellOrder,
} from "./digital-metals-customer-deep-links.js";
import { deliverDigitalMetalCustomerPushNotice } from "./digital-metals-inbox-notify.js";
import { compareRedemptionTransition } from "./digital-metals-redemption-transition-rank.js";
import {
  Customer,
  DigitalMetalBuyOrder,
  DigitalMetalDocumentArtifact,
  DigitalMetalPayout,
  DigitalMetalRedemptionOrder,
  DigitalMetalSellOrder,
  Tenant,
} from "../models/index.js";

const NOTICE_TOPICS = new Set([
  DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_CREDITED,
  DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_PAYMENT_FAILED,
  DIGITAL_METAL_OUTBOX_TOPICS.SELL_EXECUTED,
  DIGITAL_METAL_OUTBOX_TOPICS.PAYOUT_CUSTOMER_NOTICE,
  DIGITAL_METAL_OUTBOX_TOPICS.REDEMPTION_CUSTOMER_NOTICE,
  DIGITAL_METAL_OUTBOX_TOPICS.DOCUMENT_READY,
]);

const PAYOUT_RANK = Object.freeze({
  PENDING_APPROVAL: 10,
  APPROVED: 20,
  SUBMITTED: 30,
  UNKNOWN: 40,
  FAILED: 50,
  SETTLED: 50,
});

export function isDigitalMetalCustomerNoticeTopic(topic) {
  return NOTICE_TOPICS.has(topic);
}

function payoutTransitionCompare(expected, actual) {
  const e = PAYOUT_RANK[String(expected ?? "").toUpperCase()] ?? -1;
  const a = PAYOUT_RANK[String(actual ?? "").toUpperCase()] ?? -1;
  if (e < 0 || a < 0) return "UNKNOWN";
  if (a === e) return "MATCH";
  if (a > e) return "SUPERSEDED";
  return "DELAYED";
}

async function queueDigitalMetalNotice({
  tenantId,
  branchId,
  customerId,
  type,
  inboxEventKey,
  outboxEventId,
  title,
  body,
  deepLink,
  eventAt,
  templateExtras = {},
}) {
  const customer = await Customer.findOne({ _id: customerId, tenantId })
    .select("mobile whatsappOptedOutAt branchId")
    .lean();
  if (!customer) return { outcome: "CUSTOMER_NOT_FOUND" };

  return deliverDigitalMetalCustomerPushNotice({
    tenantId,
    branchId: branchId ?? customer.branchId ?? null,
    customerId,
    type,
    inboxEventKey,
    templateParams: {
      outboxEventId,
      title,
      body,
      deepLink,
      eventAt: eventAt ?? null,
      ...templateExtras,
    },
  });
}

function formatMetalQtyUg(quantityUg) {
  const ug = Number(quantityUg);
  if (!Number.isFinite(ug)) return "your metal";
  const grams = ug / 1_000_000;
  if (grams >= 1) return `${grams.toFixed(grams >= 10 ? 2 : 3)} g`;
  return `${ug} µg`;
}

async function loadTenantCode(tenantId) {
  return Tenant.findById(tenantId).select("code displayName name").lean();
}

async function handlePurchaseCredited(event) {
  const orderId = event.payload?.orderId;
  if (!orderId) return { outcome: "INVALID_PAYLOAD" };
  const order = await DigitalMetalBuyOrder.findOne({ _id: orderId, tenantId: event.tenantId }).lean();
  if (!order) return { outcome: "ORDER_NOT_FOUND" };
  if (order.status !== "CREDITED" || !order.creditedAt) {
    return { outcome: "ORDER_NOT_CREDITED" };
  }
  const tenant = await loadTenantCode(event.tenantId);
  const qty = formatMetalQtyUg(order.quantityUg);
  const inboxEventKey = digitalMetalInboxEventKey("purchase.credited", orderId);
  return queueDigitalMetalNotice({
    tenantId: event.tenantId,
    customerId: order.customerId,
    type: MessageType.DIGITAL_METAL_PURCHASE_CREDITED,
    inboxEventKey,
    outboxEventId: event._id,
    title: "Digital metal purchase credited",
    body: `Your purchase of ${qty} ${order.metal.toLowerCase()} is now in your wallet.`,
    deepLink: deepLinkBuyOrder(tenant?.code, orderId),
    eventAt: order.creditedAt?.toISOString?.() ?? event.payload?.eventAt,
    templateExtras: { orderId, metal: order.metal },
  });
}

async function handlePurchasePaymentFailed(event) {
  const orderId = event.payload?.orderId;
  if (!orderId) return { outcome: "INVALID_PAYLOAD" };
  const order = await DigitalMetalBuyOrder.findOne({ _id: orderId, tenantId: event.tenantId }).lean();
  if (!order) return { outcome: "ORDER_NOT_FOUND" };
  const reason = event.payload?.reason ?? "FAILED";
  const failedStates = new Set(["PAYMENT_FAILED", "REFUND_REVIEW"]);
  if (!failedStates.has(order.status) && reason !== "LATE_SUCCESS") {
    if (order.status === "CREDITED") return { outcome: "SKIPPED_SUPERSEDED" };
    return { outcome: "DELAYED_TRANSITION" };
  }
  const tenant = await loadTenantCode(event.tenantId);
  const inboxEventKey = digitalMetalInboxEventKey("purchase.payment_failed", orderId, reason);
  let body = "Your digital metal purchase payment could not be completed. Open the app for next steps.";
  if (reason === "LATE_SUCCESS") {
    body =
      "We received a payment after your order closed. Our team is reviewing it — no metal has been credited yet.";
  }
  return queueDigitalMetalNotice({
    tenantId: event.tenantId,
    customerId: order.customerId,
    type: MessageType.DIGITAL_METAL_PURCHASE_PAYMENT_FAILED,
    inboxEventKey,
    outboxEventId: event._id,
    title: "Digital metal purchase payment issue",
    body,
    deepLink: deepLinkBuyOrder(tenant?.code, orderId),
    eventAt: event.payload?.eventAt ?? event.createdAt?.toISOString?.(),
    templateExtras: { orderId, reason },
  });
}

async function handleSellExecuted(event) {
  const orderId = event.payload?.orderId;
  if (!orderId) return { outcome: "INVALID_PAYLOAD" };
  const order = await DigitalMetalSellOrder.findOne({ _id: orderId, tenantId: event.tenantId }).lean();
  if (!order) return { outcome: "ORDER_NOT_FOUND" };
  if (order.status !== "PAYABLE_OPEN" || !order.executedAt) {
    if (!order.executedAt && ["PENDING_APPROVAL", "RESERVED", "QUOTE_ACCEPTED"].includes(order.status)) {
      return { outcome: "DELAYED_TRANSITION" };
    }
    return { outcome: "SKIPPED_SUPERSEDED" };
  }
  const tenant = await loadTenantCode(event.tenantId);
  const amount = moneyRef(order.settlementPaise).amountDisplay;
  const inboxEventKey = digitalMetalInboxEventKey("sell.executed", orderId);
  return queueDigitalMetalNotice({
    tenantId: event.tenantId,
    customerId: order.customerId,
    type: MessageType.DIGITAL_METAL_SELL_EXECUTED,
    inboxEventKey,
    outboxEventId: event._id,
    title: "Digital metal sale executed",
    body: `Your sale for ${amount} was executed. Bank payout is processed separately — track status in the app.`,
    deepLink: deepLinkSellOrder(tenant?.code, orderId),
    eventAt: order.executedAt?.toISOString?.() ?? event.payload?.eventAt,
    templateExtras: { orderId, sellOrderId: orderId },
  });
}

function payoutCopy(transition) {
  switch (transition) {
    case "SETTLED":
      return {
        title: "Sell payout settled",
        body: "Your bank payout for a digital metal sale has been marked settled. View details in the app.",
      };
    case "FAILED":
      return {
        title: "Sell payout could not be completed",
        body: "Your bank payout failed. Update your bank details or contact support from the app.",
      };
    case "UNKNOWN":
      return {
        title: "Sell payout needs attention",
        body: "Your bank payout outcome is unknown. Open the app to see whether action is required.",
      };
    default:
      return {
        title: "Sell payout update",
        body: "There is an update on your digital metal sell payout.",
      };
  }
}

async function handlePayoutNotice(event) {
  const payoutId = event.payload?.payoutId;
  const transition = String(event.payload?.transition ?? "").toUpperCase();
  if (!payoutId || !transition) return { outcome: "INVALID_PAYLOAD" };
  const payout = await DigitalMetalPayout.findOne({ _id: payoutId, tenantId: event.tenantId }).lean();
  if (!payout) return { outcome: "PAYOUT_NOT_FOUND" };
  const cmp = payoutTransitionCompare(transition, payout.status);
  if (cmp === "DELAYED") return { outcome: "DELAYED_TRANSITION" };
  if (cmp === "SUPERSEDED") return { outcome: "SKIPPED_SUPERSEDED" };
  if (cmp !== "MATCH") return { outcome: "DELAYED_TRANSITION" };

  const sellOrder = payout.sellOrderId
    ? await DigitalMetalSellOrder.findOne({ _id: payout.sellOrderId, tenantId: event.tenantId }).lean()
    : await DigitalMetalSellOrder.findOne({ payableId: payout.payableId, tenantId: event.tenantId }).lean();
  const tenant = await loadTenantCode(event.tenantId);
  const copy = payoutCopy(transition);
  const inboxEventKey = digitalMetalInboxEventKey("payout", payoutId, transition);
  return queueDigitalMetalNotice({
    tenantId: event.tenantId,
    customerId: payout.customerId,
    type: MessageType.DIGITAL_METAL_PAYOUT_UPDATE,
    inboxEventKey,
    outboxEventId: event._id,
    title: copy.title,
    body: copy.body,
    deepLink: sellOrder?._id
      ? deepLinkSellOrder(tenant?.code, sellOrder._id)
      : deepLinkDigitalMetalsHome(tenant?.code),
    eventAt: event.payload?.eventAt,
    templateExtras: { payoutId, transition, sellOrderId: sellOrder?._id ?? null },
  });
}

function redemptionCopy(transition) {
  switch (transition) {
    case "CHARGE_PAID":
      return {
        title: "Redemption charge received",
        body: "Your redemption charge payment was accepted. We will prepare your order.",
      };
    case "FULFILMENT_ACCEPTED":
      return {
        title: "Redemption accepted",
        body: "Your physical redemption request was accepted and is being prepared.",
      };
    case "DISPATCHED":
      return {
        title: "Redemption dispatched",
        body: "Your redemption order has been dispatched. Track progress in the app.",
      };
    case "PICKUP_READY":
      return {
        title: "Redemption ready for pickup",
        body: "Your redemption order is ready for pickup at the branch. Collect using in-app verification.",
      };
    case "COMPLETED":
      return {
        title: "Redemption completed",
        body: "Your physical redemption handover is complete.",
      };
    case "CANCELLED":
      return {
        title: "Redemption cancelled",
        body: "Your redemption was cancelled before dispatch. Any eligible charge refund will be processed separately.",
      };
    case "REPLACEMENT_DISPATCHED":
      return {
        title: "Replacement shipment dispatched",
        body: "A replacement delivery is on the way for your redemption order. Track progress in the app.",
      };
    default:
      return {
        title: "Redemption update",
        body: "There is an update on your physical redemption order.",
      };
  }
}

async function handleRedemptionNotice(event) {
  const orderId = event.payload?.orderId;
  const transition = String(event.payload?.transition ?? "").toUpperCase();
  if (!orderId || !transition) return { outcome: "INVALID_PAYLOAD" };
  const order = await DigitalMetalRedemptionOrder.findOne({ _id: orderId, tenantId: event.tenantId }).lean();
  if (!order) return { outcome: "ORDER_NOT_FOUND" };
  const cmp = compareRedemptionTransition(transition, order.status);
  if (cmp === "DELAYED") return { outcome: "DELAYED_TRANSITION" };
  if (cmp === "SUPERSEDED") return { outcome: "SKIPPED_SUPERSEDED" };
  if (cmp !== "MATCH") return { outcome: "DELAYED_TRANSITION" };

  const tenant = await loadTenantCode(event.tenantId);
  const copy = redemptionCopy(transition);
  const shipmentEventId = event.payload?.shipmentEventId
    ? String(event.payload.shipmentEventId)
    : null;
  const inboxSegment = shipmentEventId ? `${transition}:${shipmentEventId}` : transition;
  const inboxEventKey = digitalMetalInboxEventKey("redemption", orderId, inboxSegment);
  return queueDigitalMetalNotice({
    tenantId: event.tenantId,
    customerId: order.customerId,
    type: MessageType.DIGITAL_METAL_REDEMPTION_UPDATE,
    inboxEventKey,
    outboxEventId: event._id,
    title: copy.title,
    body: copy.body,
    deepLink: deepLinkRedemptionOrder(tenant?.code, orderId),
    eventAt: event.payload?.eventAt,
    templateExtras: { redemptionOrderId: orderId, transition },
  });
}

const DOC_LABELS = {
  METAL_STATEMENT: "Account statement",
  REDEMPTION_CHARGE_RECEIPT: "Redemption charge receipt",
  HANDOVER_RECEIPT: "Handover receipt",
  SELL_ACKNOWLEDGEMENT: "Sell acknowledgement",
  PAYOUT_RECEIPT: "Payout receipt",
};

async function handleDocumentReady(event) {
  const artifactId = event.payload?.artifactId;
  if (!artifactId) return { outcome: "INVALID_PAYLOAD" };
  const artifact = await DigitalMetalDocumentArtifact.findOne({
    _id: artifactId,
    tenantId: event.tenantId,
  }).lean();
  if (!artifact) return { outcome: "ORDER_NOT_FOUND" };
  if (artifact.status !== "READY" || !artifact.uploadId) {
    return { outcome: "DOCUMENT_NOT_READY" };
  }
  const customerId = artifact.customerId ?? event.payload?.customerId;
  if (!customerId) return { outcome: "CUSTOMER_UNKNOWN" };
  const tenant = await loadTenantCode(event.tenantId);
  const label = DOC_LABELS[artifact.docType] ?? "Document";
  const inboxEventKey = digitalMetalInboxEventKey("document.ready", artifactId);
  return queueDigitalMetalNotice({
    tenantId: event.tenantId,
    customerId,
    type: MessageType.DIGITAL_METAL_DOCUMENT_READY,
    inboxEventKey,
    outboxEventId: event._id,
    title: `${label} ready`,
    body: `Your requested ${label.toLowerCase()} is ready to download from the app.`,
    deepLink: deepLinkDocumentArtifact(tenant?.code, artifactId),
    eventAt: artifact.updatedAt?.toISOString?.() ?? event.payload?.eventAt,
    templateExtras: { artifactId, docType: artifact.docType },
  });
}

export async function processDigitalMetalCustomerNoticeOutboxEvent(event) {
  if (!isDigitalMetalCustomerNoticeTopic(event.topic)) {
    return { outcome: "NOT_A_NOTICE_TOPIC" };
  }
  switch (event.topic) {
    case DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_CREDITED:
      return handlePurchaseCredited(event);
    case DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_PAYMENT_FAILED:
      return handlePurchasePaymentFailed(event);
    case DIGITAL_METAL_OUTBOX_TOPICS.SELL_EXECUTED:
      return handleSellExecuted(event);
    case DIGITAL_METAL_OUTBOX_TOPICS.PAYOUT_CUSTOMER_NOTICE:
      return handlePayoutNotice(event);
    case DIGITAL_METAL_OUTBOX_TOPICS.REDEMPTION_CUSTOMER_NOTICE:
      return handleRedemptionNotice(event);
    case DIGITAL_METAL_OUTBOX_TOPICS.DOCUMENT_READY:
      return handleDocumentReady(event);
    default:
      return { outcome: "UNKNOWN_TOPIC" };
  }
}
