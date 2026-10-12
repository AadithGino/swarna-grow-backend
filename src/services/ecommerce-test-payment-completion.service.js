import { CallbackType } from "@phonepe-pg/pg-sdk-node";
import { EcommerceOrderStatus, EcommercePaymentAttemptStatus } from "../constants/enums.js";
import { errors } from "../lib/app-error.js";
import { isEcommercePaymentsTestHarnessEnabled } from "../lib/ecommerce-test-harness.js";
import {
  EcommerceOrder,
  EcommercePaymentAttempt,
  WebhookEvent,
} from "../models/index.js";
import { createId } from "../lib/ids.js";
import { processWebhook } from "../workers/processors.js";

function assertHarnessRouteEnabled() {
  if (!isEcommercePaymentsTestHarnessEnabled()) {
    throw errors.notFound("Route");
  }
}

export function testPaymentHarnessMetaForClient() {
  if (!isEcommercePaymentsTestHarnessEnabled()) {
    return { available: false };
  }
  return {
    available: true,
    label: "TEST ONLY — mock PhonePe completion (NODE_ENV=test harness)",
    outcomes: ["COMPLETED", "FAILED"],
  };
}

async function queuePhonePeWebhook({ tenantId, type, payload, providerEventId }) {
  const eventId = createId("webhook");
  await WebhookEvent.create({
    _id: eventId,
    tenantId,
    provider: "PHONEPE",
    providerEventId,
    status: "QUEUED",
    payload: { type, payload },
  });
  await processWebhook({ data: { webhookEventId: eventId }, attemptsMade: 0 });
  return eventId;
}

/**
 * Customer-authenticated mock payment completion for manual UI walkthroughs.
 * Never available outside NODE_ENV=test + ECOMMERCE_PAYMENTS_TEST_HARNESS.
 */
export async function completeTestHarnessShopPayment(req) {
  assertHarnessRouteEnabled();
  const outcome = String(req.body?.outcome ?? "COMPLETED").trim().toUpperCase();
  if (!["COMPLETED", "FAILED"].includes(outcome)) {
    throw errors.validation([{ field: "outcome", message: "Use COMPLETED or FAILED." }]);
  }
  const order = await EcommerceOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  if (!order) throw errors.notFound("Order");
  if (order.status !== EcommerceOrderStatus.PENDING_PAYMENT) {
    throw errors.business("ORDER_NOT_PAYABLE", "Order is not awaiting payment.", {
      status: order.status,
    });
  }
  const attemptId = String(req.body?.paymentAttemptId ?? "").trim();
  const attempt = attemptId
    ? await EcommercePaymentAttempt.findOne({
        _id: attemptId,
        tenantId: req.auth.tenantId,
        orderId: order._id,
      }).lean()
    : await EcommercePaymentAttempt.findOne({
        tenantId: req.auth.tenantId,
        orderId: order._id,
        status: { $in: [EcommercePaymentAttemptStatus.INITIATED, EcommercePaymentAttemptStatus.PENDING] },
      })
        .sort({ createdAt: -1 })
        .lean();
  if (!attempt) {
    throw errors.business("PAYMENT_ATTEMPT_REQUIRED", "Create a payment attempt before mock completion.", {});
  }
  const merchantOrderId = attempt.merchantOrderId ?? attempt._id;
  const amountPaise = order.totalPaise ?? 0;
  const transactionId = `test-harness-${attempt._id}`;

  if (outcome === "FAILED") {
    await queuePhonePeWebhook({
      tenantId: req.auth.tenantId,
      type: "CHECKOUT_ORDER_FAILED",
      providerEventId: `test-fail-${attempt._id}`,
      payload: {
        originalMerchantOrderId: merchantOrderId,
        amount: amountPaise,
        paymentDetails: [{ state: "FAILED", transactionId, amount: amountPaise }],
      },
    });
  } else {
    await queuePhonePeWebhook({
      tenantId: req.auth.tenantId,
      type: CallbackType.CHECKOUT_ORDER_COMPLETED,
      providerEventId: `test-ok-${attempt._id}`,
      payload: {
        originalMerchantOrderId: merchantOrderId,
        amount: amountPaise,
        currency: "INR",
        paymentDetails: [{ state: "COMPLETED", transactionId, amount: amountPaise }],
      },
    });
  }

  const freshOrder = await EcommerceOrder.findById(order._id).lean();
  const freshAttempt = await EcommercePaymentAttempt.findById(attempt._id).lean();
  return {
    outcome,
    orderId: order._id,
    orderStatus: freshOrder?.status ?? null,
    paymentAttemptId: attempt._id,
    paymentAttemptStatus: freshAttempt?.status ?? null,
    testOnly: true,
  };
}
