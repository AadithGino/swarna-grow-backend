import {
  EcommerceOrderCancellationRequestStatus,
  EcommerceOrderStatus,
  EcommercePaymentAttemptStatus,
  EcommercePaymentExceptionRefundStatus,
  MessageType,
} from "../constants/enums.js";
import { moneyRef } from "./money.js";
import { ECOMMERCE_OUTBOX_TOPICS } from "./ecommerce-commerce-outbox.js";
import {
  Customer,
  EcommerceOrder,
  EcommerceOrderCancellationRequest,
  EcommercePaymentAttempt,
  EcommercePaymentExceptionRefund,
  Message,
} from "../models/index.js";

const ECOMMERCE_TOPICS = new Set(Object.values(ECOMMERCE_OUTBOX_TOPICS));

export function isEcommerceOutboxTopic(topic) {
  return ECOMMERCE_TOPICS.has(topic);
}

function branchIdForOrder(order) {
  return order.pickupBranchId ?? order.addressSnapshot?.branchId ?? null;
}

async function loadOrderContext(tenantId, orderId) {
  const order = await EcommerceOrder.findOne({ _id: orderId, tenantId }).lean();
  if (!order) return null;
  const customer = await Customer.findOne({ _id: order.customerId, tenantId })
    .select("mobile whatsappOptedOutAt branchId")
    .lean();
  if (!customer) return { order, customer: null };
  return { order, customer };
}

async function notificationAlreadySent({ tenantId, inboxEventKey }) {
  return Message.exists({
    tenantId,
    "templateParams.inboxEventKey": inboxEventKey,
  });
}

async function queueEcommerceCustomerNotice({
  tenantId,
  branchId,
  customerId,
  type,
  inboxEventKey,
  outboxEventId,
  order,
  title,
  body,
  deepLink,
}) {
  const exists = await notificationAlreadySent({ tenantId, inboxEventKey });
  if (exists) return { outcome: "ALREADY_NOTIFIED" };

  const { queueCustomerNotification } = await import("../services/customer-notification.service.js");
  const customer = await Customer.findOne({ _id: customerId, tenantId })
    .select("mobile whatsappOptedOutAt")
    .lean();
  if (!customer) return { outcome: "CUSTOMER_NOT_FOUND" };

  const result = await queueCustomerNotification({
    tenantId,
    branchId,
    customerId,
    schemeId: null,
    type,
    pushOnly: true,
    customer,
    templateParams: {
      inboxEventKey,
      outboxEventId,
      orderId: order._id,
      orderNumber: order.orderNumber,
      title,
      body,
      deepLink,
    },
  });
  if (!result.queued?.length) {
    return { outcome: "NO_DELIVERY_CHANNEL" };
  }
  return { outcome: "QUEUED", count: result.queued.length };
}

function orderDeepLink(orderId) {
  return `/shop/order/${orderId}`;
}

async function handlePaymentSucceeded(event, ctx) {
  const { order, customer } = ctx;
  if (event.payload?.duplicateException) {
    return { handled: true, outcome: "SKIPPED_DUPLICATE_EXCEPTION" };
  }
  if (order.status !== EcommerceOrderStatus.PAID || !order.paidAt) {
    return { handled: true, outcome: "ORDER_NOT_PAID" };
  }
  const attemptId = event.payload?.paymentAttemptId;
  if (attemptId && order.successfulPaymentAttemptId !== attemptId) {
    return { handled: true, outcome: "PAYMENT_ATTEMPT_MISMATCH" };
  }
  if (attemptId) {
    const attempt = await EcommercePaymentAttempt.findOne({
      _id: attemptId,
      tenantId: event.tenantId,
      orderId: order._id,
    }).lean();
    if (!attempt || attempt.status !== EcommercePaymentAttemptStatus.SUCCEEDED) {
      return { handled: true, outcome: "ATTEMPT_NOT_SUCCEEDED" };
    }
  }
  const amount = moneyRef(order.totalPaise).amountDisplay;
  return {
    handled: true,
    ...(await queueEcommerceCustomerNotice({
      tenantId: event.tenantId,
      branchId: branchIdForOrder(order) ?? customer?.branchId,
      customerId: order.customerId,
      type: MessageType.ECOMMERCE_ORDER_CONFIRMED,
      inboxEventKey: `ecommerce.payment.succeeded:${order._id}:${order.successfulPaymentAttemptId}`,
      outboxEventId: event._id,
      order,
      title: "Order confirmed",
      body: `Your order ${order.orderNumber} is confirmed. We received ${amount} online. Track progress in the shop.`,
      deepLink: orderDeepLink(order._id),
    })),
  };
}

async function handlePaymentFailed(event, ctx) {
  const { order } = ctx;
  if (order.status === EcommerceOrderStatus.PAID) {
    return { handled: true, outcome: "ORDER_ALREADY_PAID" };
  }
  const attemptId = event.payload?.paymentAttemptId ?? "unknown";
  return {
    handled: true,
    ...(await queueEcommerceCustomerNotice({
      tenantId: event.tenantId,
      branchId: branchIdForOrder(order),
      customerId: order.customerId,
      type: MessageType.ECOMMERCE_PAYMENT_FAILED,
      inboxEventKey: `ecommerce.payment.failed:${order._id}:${attemptId}`,
      outboxEventId: event._id,
      order,
      title: "Payment not completed",
      body: `Online payment for order ${order.orderNumber} did not complete. You can retry from your order details if the window is still open.`,
      deepLink: orderDeepLink(order._id),
    })),
  };
}

async function handlePaymentExpired(event, ctx) {
  const { order } = ctx;
  if (order.status !== EcommerceOrderStatus.PAYMENT_EXPIRED) {
    return { handled: true, outcome: "ORDER_NOT_EXPIRED" };
  }
  return {
    handled: true,
    ...(await queueEcommerceCustomerNotice({
      tenantId: event.tenantId,
      branchId: branchIdForOrder(order),
      customerId: order.customerId,
      type: MessageType.ECOMMERCE_PAYMENT_EXPIRED,
      inboxEventKey: `ecommerce.payment.expired:${order._id}`,
      outboxEventId: event._id,
      order,
      title: "Payment window closed",
      body: `The payment window for order ${order.orderNumber} has expired. No charge was made.`,
      deepLink: orderDeepLink(order._id),
    })),
  };
}

async function handleRefundCompleted(event, ctx) {
  const { order } = ctx;
  const refundId = event.payload?.refundId ?? event.payload?.paymentExceptionRefundId;
  const refund = refundId
    ? await EcommercePaymentExceptionRefund.findOne({
        _id: refundId,
        tenantId: event.tenantId,
        orderId: order._id,
      }).lean()
    : await EcommercePaymentExceptionRefund.findOne({
        tenantId: event.tenantId,
        orderId: order._id,
        status: {
          $in: [
            EcommercePaymentExceptionRefundStatus.SUCCEEDED,
            EcommercePaymentExceptionRefundStatus.MANUAL_RECORDED,
          ],
        },
      })
        .sort({ updatedAt: -1 })
        .lean();
  if (
    !refund
    || ![
      EcommercePaymentExceptionRefundStatus.SUCCEEDED,
      EcommercePaymentExceptionRefundStatus.MANUAL_RECORDED,
    ].includes(refund.status)
  ) {
    return { handled: true, outcome: "REFUND_NOT_CONFIRMED" };
  }
  const amount = moneyRef(refund.amountPaise ?? order.totalPaise).amountDisplay;
  return {
    handled: true,
    ...(await queueEcommerceCustomerNotice({
      tenantId: event.tenantId,
      branchId: branchIdForOrder(order),
      customerId: order.customerId,
      type: MessageType.ECOMMERCE_REFUND_COMPLETED,
      inboxEventKey: `ecommerce.refund.completed:${order._id}:${refund._id}`,
      outboxEventId: event._id,
      order,
      title: "Refund confirmed",
      body: `A refund of ${amount} for order ${order.orderNumber} has been confirmed. It may take a few days to appear in your account.`,
      deepLink: orderDeepLink(order._id),
    })),
  };
}

async function handleFulfilmentMilestone(event, ctx) {
  const { order } = ctx;
  const status = event.payload?.status ?? order.status;
  let copy;
  switch (status) {
    case EcommerceOrderStatus.PROCESSING:
      copy = {
        title: "Order in progress",
        body: `Your order ${order.orderNumber} is being prepared.`,
      };
      break;
    case EcommerceOrderStatus.READY_FOR_PICKUP:
      copy = {
        title: "Ready for pickup",
        body: `Order ${order.orderNumber} is ready for pickup at the store.`,
      };
      break;
    case EcommerceOrderStatus.SHIPPED: {
      let body = `Order ${order.orderNumber} has been dispatched.`;
      if (order.deliveryTracking?.trackingNumber) {
        body += " Tracking details are in your order page.";
      }
      copy = { title: "Order shipped", body };
      break;
    }
    case EcommerceOrderStatus.DELIVERED:
      copy = {
        title: "Order delivered",
        body: `Order ${order.orderNumber} has been delivered.`,
      };
      break;
    default:
      return { handled: true, outcome: "STATUS_NOT_NOTIFIABLE" };
  }
  const { title, body } = copy;
  return {
    handled: true,
    ...(await queueEcommerceCustomerNotice({
      tenantId: event.tenantId,
      branchId: branchIdForOrder(order),
      customerId: order.customerId,
      type: MessageType.ECOMMERCE_FULFILMENT_UPDATE,
      inboxEventKey: `ecommerce.fulfilment.milestone:${order._id}:${status}`,
      outboxEventId: event._id,
      order,
      title,
      body,
      deepLink: orderDeepLink(order._id),
    })),
  };
}

async function handleOrderUpdated(event, ctx) {
  const { order } = ctx;
  const kind = event.payload?.kind;
  if (kind === "COD_ACCEPTED") {
    return {
      handled: true,
      ...(await queueEcommerceCustomerNotice({
        tenantId: event.tenantId,
        branchId: branchIdForOrder(order),
        customerId: order.customerId,
        type: MessageType.ECOMMERCE_COD_UPDATE,
        inboxEventKey: `ecommerce-outbox:${event._id}`,
        outboxEventId: event._id,
        order,
        title: "COD order accepted",
        body: `Your cash-on-delivery order ${order.orderNumber} was accepted. Payment is due on delivery.`,
        deepLink: orderDeepLink(order._id),
      })),
    };
  }
  if (kind === "COD_REJECTED") {
    return {
      handled: true,
      ...(await queueEcommerceCustomerNotice({
        tenantId: event.tenantId,
        branchId: branchIdForOrder(order),
        customerId: order.customerId,
        type: MessageType.ECOMMERCE_COD_UPDATE,
        inboxEventKey: `ecommerce-outbox:${event._id}`,
        outboxEventId: event._id,
        order,
        title: "COD order not accepted",
        body: `Your cash-on-delivery order ${order.orderNumber} could not be accepted by the store.`,
        deepLink: orderDeepLink(order._id),
      })),
    };
  }
  const cancellationRequestId = event.payload?.cancellationRequestId;
  if (cancellationRequestId) {
    const reqRow = await EcommerceOrderCancellationRequest.findOne({
      _id: cancellationRequestId,
      tenantId: event.tenantId,
      orderId: order._id,
    }).lean();
    if (!reqRow) return { handled: true, outcome: "CANCELLATION_NOT_FOUND" };
    if (reqRow.status === EcommerceOrderCancellationRequestStatus.PENDING_DECISION) {
      return {
        handled: true,
        ...(await queueEcommerceCustomerNotice({
          tenantId: event.tenantId,
          branchId: branchIdForOrder(order),
          customerId: order.customerId,
          type: MessageType.ECOMMERCE_CANCELLATION_UPDATE,
          inboxEventKey: `ecommerce-outbox:${event._id}`,
          outboxEventId: event._id,
          order,
          title: "Cancellation request received",
          body: `We received your cancellation request for order ${order.orderNumber}. The store will review it shortly.`,
          deepLink: orderDeepLink(order._id),
        })),
      };
    }
    if (reqRow.status === EcommerceOrderCancellationRequestStatus.REJECTED) {
      return {
        handled: true,
        ...(await queueEcommerceCustomerNotice({
          tenantId: event.tenantId,
          branchId: branchIdForOrder(order),
          customerId: order.customerId,
          type: MessageType.ECOMMERCE_CANCELLATION_UPDATE,
          inboxEventKey: `ecommerce-outbox:${event._id}`,
          outboxEventId: event._id,
          order,
          title: "Cancellation request declined",
          body: `Your cancellation request for order ${order.orderNumber} was declined.${reqRow.decisionReason ? ` Reason: ${reqRow.decisionReason}` : ""}`,
          deepLink: orderDeepLink(order._id),
        })),
      };
    }
    if (
      reqRow.status === EcommerceOrderCancellationRequestStatus.APPROVED_PROCESSING
      || reqRow.status === EcommerceOrderCancellationRequestStatus.COMPLETED
    ) {
      return {
        handled: true,
        ...(await queueEcommerceCustomerNotice({
          tenantId: event.tenantId,
          branchId: branchIdForOrder(order),
          customerId: order.customerId,
          type: MessageType.ECOMMERCE_CANCELLATION_UPDATE,
          inboxEventKey: `ecommerce-outbox:${event._id}`,
          outboxEventId: event._id,
          order,
          title: "Cancellation approved",
          body: `Your cancellation for order ${order.orderNumber} was approved. Any refund will be processed separately — we will notify you when it is confirmed.`,
          deepLink: orderDeepLink(order._id),
        })),
      };
    }
  }
  return { handled: true, outcome: "ORDER_UPDATE_NOOP" };
}

/**
 * Process one ecommerce outbox row. Returns { handled, outcome }.
 * Throws on transient errors so Bull can retry.
 */
export async function processEcommerceOutboxEvent(event) {
  if (!isEcommerceOutboxTopic(event.topic)) {
    return { handled: false };
  }
  const orderId = String(event.payload?.orderId ?? event.key ?? "").split(":")[0];
  if (!orderId) return { handled: true, outcome: "MISSING_ORDER_ID" };

  const ctx = await loadOrderContext(event.tenantId, orderId);
  if (!ctx?.order) return { handled: true, outcome: "ORDER_NOT_FOUND" };

  switch (event.topic) {
    case ECOMMERCE_OUTBOX_TOPICS.PAYMENT_SUCCEEDED:
      return handlePaymentSucceeded(event, ctx);
    case ECOMMERCE_OUTBOX_TOPICS.PAYMENT_FAILED:
      return handlePaymentFailed(event, ctx);
    case ECOMMERCE_OUTBOX_TOPICS.PAYMENT_EXPIRED:
      return handlePaymentExpired(event, ctx);
    case ECOMMERCE_OUTBOX_TOPICS.REFUND_COMPLETED:
      return handleRefundCompleted(event, ctx);
    case ECOMMERCE_OUTBOX_TOPICS.FULFILMENT_MILESTONE:
      return handleFulfilmentMilestone(event, ctx);
    case ECOMMERCE_OUTBOX_TOPICS.ORDER_UPDATED:
      return handleOrderUpdated(event, ctx);
    default:
      return { handled: true, outcome: "UNKNOWN_ECOMMERCE_TOPIC" };
  }
}
