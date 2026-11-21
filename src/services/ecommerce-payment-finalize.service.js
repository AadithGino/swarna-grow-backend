import { IDENTITY_CHANGED, identityFilter, sameIdentity } from "../lib/ecommerce-payment-identity.js";
import { isBookingPayment } from "../lib/ecommerce-payment-allocations.js";
import {
  finalizeBookingPaymentSuccess,
  finalizeBookingPaymentTerminalFailure,
} from "./ecommerce-booking-payment.service.js";
import { postAssistedOrderCash } from "../lib/counter-tender.js";
import { createId } from "../lib/ids.js";
import { withTransaction } from "../lib/transaction.js";
import { assertEcommerceOrderTransition } from "../lib/ecommerce-order-transitions.js";
import {
  EcommerceOrderEventType,
  EcommerceOrderPaymentExceptionStatus,
  EcommerceOrderStatus,
  EcommerceStockReleaseReason,
  EcommercePaymentAttemptOperationalStatus,
  EcommercePaymentAttemptStatus,
} from "../constants/enums.js";
import {
  EcommerceOrder,
  EcommerceOrderEvent,
  EcommercePaymentAttempt,
  EcommercePaymentAttemptEvent,
  EcommercePaymentExceptionRefund,
} from "../models/index.js";
import {
  ECOMMERCE_OUTBOX_TOPICS,
  enqueueEcommerceOutboxEvent,
} from "../lib/ecommerce-commerce-outbox.js";
import { EcommercePaymentExceptionRefundStatus } from "../constants/enums.js";
import { upsertOperationalAlert } from "../lib/operational-alert.js";
import { AlertType } from "../constants/enums.js";
import { validatePhonePeCompletedIdentifiers } from "../lib/phonepe-completed-identifiers.js";
import { assertLinkedSchemeBacking } from "./ecommerce-scheme-reservation.service.js";
import { cancelPendingPaymentOrderRow, consumeOrderStockReservationsOnce } from "../lib/ecommerce-order-lifecycle.js";

async function recordAttemptEvent({
  tenantId,
  orderId,
  paymentAttemptId,
  webhookEventId,
  direction,
  outcome,
  reason,
  payload,
  session,
}) {
  await EcommercePaymentAttemptEvent.create(
    [
      {
        _id: createId("epayev"),
        tenantId,
        orderId,
        paymentAttemptId,
        webhookEventId: webhookEventId ?? null,
        direction,
        outcome,
        reason: reason ?? "",
        payload: payload ?? {},
      },
    ],
    { session },
  );
}

export async function finalizeEcommercePaymentSuccess({
  tenantId,
  merchantOrderId,
  transactionId,
  amountPaise,
  currency = "INR",
  providerPayload,
  webhookEventId,
  source = "WEBHOOK",
  expectedIdentity,
}) {
  const attempt = await EcommercePaymentAttempt.findOne({
    tenantId,
    $or: [{ _id: merchantOrderId }, { merchantOrderId }, { providerOrderId: merchantOrderId }],
  }).lean();
  if (!attempt) return { outcome: "NOT_FOUND" };
  // A booking capture has no order to load or lock: it belongs to the booking payment finalizer.
  // Never let the order-bound path below treat one as ordinary checkout.
  if (isBookingPayment(attempt)) {
    return finalizeBookingPaymentSuccess({
      attempt, transactionId, amountPaise, currency, providerPayload, webhookEventId, source, expectedIdentity,
    });
  }

  if (attempt.status === EcommercePaymentAttemptStatus.SUCCEEDED) {
    if (attempt.provider === "COUNTER") await withTransaction(async (session) => {
      const order = await EcommerceOrder.findOne({ _id: attempt.orderId, tenantId }).session(session).lean();
      if (!order) throw new Error("Counter order missing");
      await postAssistedOrderCash(session, order, "ECOMMERCE_COUNTER_ORDER");
    });
    return { outcome: "ALREADY_SUCCESS", orderId: attempt.orderId };
  }
  const attemptCurrency = String(attempt.currency ?? "INR");
  if (attemptCurrency !== String(currency ?? "INR")) {
    await recordAttemptEvent({
      tenantId,
      orderId: attempt.orderId,
      paymentAttemptId: attempt._id,
      webhookEventId,
      direction: "INBOUND",
      outcome: "CURRENCY_MISMATCH",
      reason: `Expected ${attemptCurrency}, got ${currency}`,
      payload: providerPayload,
    });
    return { outcome: "CURRENCY_MISMATCH", orderId: attempt.orderId };
  }
  if (Number(attempt.amountPaise) !== Number(amountPaise)) {
    await recordAttemptEvent({
      tenantId,
      orderId: attempt.orderId,
      paymentAttemptId: attempt._id,
      webhookEventId,
      direction: "INBOUND",
      outcome: "AMOUNT_MISMATCH",
      reason: `Expected ${attempt.amountPaise}, got ${amountPaise}`,
      payload: providerPayload,
    });
    return { outcome: "AMOUNT_MISMATCH", orderId: attempt.orderId };
  }

  return withTransaction(async (session) => {
    const order = await EcommerceOrder.findOne({
      _id: attempt.orderId,
      tenantId,
    }).session(session);
    if (!order) return { outcome: "ORDER_NOT_FOUND" };

    const currentAttempt = await EcommercePaymentAttempt.findById(attempt._id).session(session).lean();
    // The attempt document is written later in this transaction, so a concurrent identity change
    // conflicts and retries; this read therefore decides on the identity that will be written.
    if (expectedIdentity && currentAttempt && !sameIdentity(expectedIdentity, currentAttempt)) {
      return { outcome: IDENTITY_CHANGED, orderId: order._id };
    }
    if (currentAttempt?.status === EcommercePaymentAttemptStatus.SUCCEEDED) {
      return { outcome: "ALREADY_SUCCESS", orderId: order._id };
    }
    if (order.successfulPaymentAttemptId || order.status === EcommerceOrderStatus.PAID) {
      const winningAttemptId = order.successfulPaymentAttemptId ?? null;
      if (
        attempt.status === EcommercePaymentAttemptStatus.SUCCEEDED
        || (winningAttemptId && attempt._id === winningAttemptId)
      ) {
        return { outcome: "ALREADY_SUCCESS", orderId: order._id };
      }
      await EcommercePaymentAttempt.updateOne(
        { _id: attempt._id, status: { $ne: EcommercePaymentAttemptStatus.SUCCEEDED } },
        {
          $set: {
            status: EcommercePaymentAttemptStatus.SUCCEEDED,
            providerPaymentId: transactionId,
            providerPayload,
            operationalStatus: EcommercePaymentAttemptOperationalStatus.NORMAL,
          },
          $inc: { version: 1 },
        },
        { session },
      );
      await EcommerceOrder.updateOne(
        { _id: order._id },
        {
          $set: {
            paymentExceptionStatus:
              EcommerceOrderPaymentExceptionStatus.DUPLICATE_PAYMENT_REFUND_REQUIRED,
            paymentExceptionPayload: {
              paymentAttemptId: attempt._id,
              successfulPaymentAttemptId: winningAttemptId,
              transactionId,
              amountPaise,
              at: new Date().toISOString(),
            },
          },
          $inc: { version: 1 },
        },
        { session },
      );
      await EcommerceOrderEvent.create(
        [
          {
            _id: createId("eoev"),
            tenantId,
            orderId: order._id,
            type: EcommerceOrderEventType.PAYMENT_DUPLICATE_SUCCESS_EXCEPTION,
            actorType: "SYSTEM",
            payload: {
              paymentAttemptId: attempt._id,
              successfulPaymentAttemptId: winningAttemptId,
              transactionId,
            },
          },
        ],
        { session },
      );
      await recordAttemptEvent({
        tenantId,
        orderId: order._id,
        paymentAttemptId: attempt._id,
        webhookEventId,
        direction: "INBOUND",
        outcome: "DUPLICATE_PAYMENT_EXCEPTION",
        reason: "Order already paid via another attempt",
        payload: providerPayload,
        session,
      });
      await EcommercePaymentExceptionRefund.findOneAndUpdate(
        { tenantId, refundOperationId: `exception:${attempt._id}`, paymentAttemptId: attempt._id },
        {
          $setOnInsert: {
            paymentAttemptId: attempt._id,
            amountPaise: attempt.amountPaise,
            currency: attemptCurrency,
            providerPaymentId: transactionId,
            merchantOrderId: attempt.merchantOrderId ?? attempt._id,
            _id: createId("epayref"),
            tenantId,
            orderId: order._id,
            status: EcommercePaymentExceptionRefundStatus.ASSIGNED,
          },
        },
        { session, upsert: true },
      );
      await upsertOperationalAlert({
        tenantId,
        type: AlertType.GATEWAY_WEBHOOK_UNMATCHED,
        entityId: order._id,
        title: "Ecommerce duplicate payment",
        message:
          "A second successful payment was received for an already paid order; refund review required.",
        metadata: {
          orderId: order._id,
          paymentAttemptId: attempt._id,
          successfulPaymentAttemptId: winningAttemptId,
          transactionId,
        },
      });
      await enqueueEcommerceOutboxEvent({
        tenantId,
        topic: ECOMMERCE_OUTBOX_TOPICS.PAYMENT_SUCCEEDED,
        key: `${order._id}:${attempt._id}:duplicate-exception`,
        payload: {
          orderId: order._id,
          paymentAttemptId: attempt._id,
          duplicateException: true,
          source,
        },
        session,
      });
      return { outcome: "DUPLICATE_PAYMENT_EXCEPTION", orderId: order._id };
    }

    let lateCaptureReason;
    if (order.status === EcommerceOrderStatus.PENDING_PAYMENT && order.financialSnapshot?.schemePurchase) {
      try {
        await assertLinkedSchemeBacking(order, session);
      } catch (err) {
        if (!["SCHEME_BACKING_CHANGED", "KYC_REQUIRED"].includes(err?.code)) throw err;
        const cancelled = await cancelPendingPaymentOrderRow({
          orderId: order._id, tenantId, customerId: order.customerId, session,
          stockReleaseReason: EcommerceStockReleaseReason.SCHEME_BACKING_CHANGED,
        });
        if (cancelled.kind !== "OK") throw err;
        lateCaptureReason = err.code;
      }
    }
    const terminalWithoutStock = [
      EcommerceOrderStatus.PAYMENT_EXPIRED,
      EcommerceOrderStatus.CANCELLED,
    ].includes(order.status);

    if (terminalWithoutStock || lateCaptureReason) {
      await EcommercePaymentAttempt.updateOne(
        { _id: attempt._id },
        {
          $set: {
            status: EcommercePaymentAttemptStatus.SUCCEEDED,
            providerPaymentId: transactionId,
            providerPayload,
          },
          $inc: { version: 1 },
        },
        { session },
      );
      await EcommerceOrder.updateOne(
        { _id: order._id },
        {
          $set: {
            paymentExceptionStatus: EcommerceOrderPaymentExceptionStatus.LATE_SUCCESS_REFUND_REQUIRED,
            paymentExceptionPayload: {
              paymentAttemptId: attempt._id,
              transactionId,
              amountPaise,
              priorStatus: order.status,
              ...(lateCaptureReason ? { reason: lateCaptureReason } : {}),
              at: new Date().toISOString(),
            },
          },
          $inc: { version: 1 },
        },
        { session },
      );
      await EcommerceOrderEvent.create(
        [
          {
            _id: createId("eoev"),
            tenantId,
            orderId: order._id,
            type: EcommerceOrderEventType.PAYMENT_LATE_SUCCESS_EXCEPTION,
            actorType: "SYSTEM",
            payload: { paymentAttemptId: attempt._id, transactionId },
          },
        ],
        { session },
      );
      await recordAttemptEvent({
        tenantId,
        orderId: order._id,
        paymentAttemptId: attempt._id,
        webhookEventId,
        direction: "INBOUND",
        outcome: "LATE_SUCCESS_EXCEPTION",
        reason: lateCaptureReason ?? `Order was ${order.status} when payment succeeded`,
        payload: providerPayload,
        session,
      });
      await EcommercePaymentExceptionRefund.updateOne(
        { tenantId, refundOperationId: `exception:${attempt._id}`, paymentAttemptId: attempt._id },
        {
          $setOnInsert: {
            _id: createId("epayref"),
            tenantId,
            orderId: order._id,
            paymentAttemptId: attempt._id,
            amountPaise: attempt.amountPaise,
            currency: attemptCurrency,
            providerPaymentId: transactionId,
            merchantOrderId: attempt.merchantOrderId ?? attempt._id,
            status: EcommercePaymentExceptionRefundStatus.ASSIGNED,
          },
        },
        { session, upsert: true },
      );
      await enqueueEcommerceOutboxEvent({
        tenantId,
        topic: ECOMMERCE_OUTBOX_TOPICS.PAYMENT_SUCCEEDED,
        key: `${order._id}:${attempt._id}:late-exception`,
        payload: {
          orderId: order._id,
          paymentAttemptId: attempt._id,
          lateException: true,
          source,
        },
        session,
      });
      await upsertOperationalAlert({
        tenantId,
        type: AlertType.GATEWAY_WEBHOOK_UNMATCHED,
        entityId: order._id,
        title: "Ecommerce late payment success",
        message: lateCaptureReason
          ? "Top-up was captured after scheme backing became invalid. The order was cancelled and needs refund review."
          : "Payment succeeded after order expired or was cancelled; refund review required. Order was not marked paid.",
        metadata: { orderId: order._id, paymentAttemptId: attempt._id, transactionId },
      });
      return { outcome: "LATE_SUCCESS_EXCEPTION", orderId: order._id };
    }

    if (order.status !== EcommerceOrderStatus.PENDING_PAYMENT) {
      return { outcome: "ORDER_NOT_PAYABLE", orderId: order._id, status: order.status };
    }

    assertEcommerceOrderTransition(
      "SYSTEM",
      order.status,
      EcommerceOrderStatus.PAID,
    );

    const paidAt = new Date();
    const paidOrder = await EcommerceOrder.findOneAndUpdate(
      { _id: order._id, tenantId, status: EcommerceOrderStatus.PENDING_PAYMENT },
      {
        $set: {
          status: EcommerceOrderStatus.PAID,
          paidAt,
          successfulPaymentAttemptId: attempt._id,
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    );
    if (!paidOrder) {
      const current = await EcommerceOrder.findById(order._id).session(session);
      if (current?.status === EcommerceOrderStatus.PAID) {
        return { outcome: "ALREADY_SUCCESS", orderId: order._id };
      }
      return { outcome: "ORDER_NOT_PAYABLE", orderId: order._id, status: current?.status };
    }
    await EcommercePaymentAttempt.updateOne(
      {
        _id: attempt._id,
        status: { $ne: EcommercePaymentAttemptStatus.SUCCEEDED },
      },
      {
        $set: {
          status: EcommercePaymentAttemptStatus.SUCCEEDED,
          providerPaymentId: transactionId,
          providerPayload,
          operationalStatus: EcommercePaymentAttemptOperationalStatus.NORMAL,
        },
        $inc: { version: 1 },
      },
      { session },
    );
    await EcommerceOrderEvent.create(
      [
        {
          _id: createId("eoev"),
          tenantId,
          orderId: order._id,
          type: EcommerceOrderEventType.PAYMENT_SUCCEEDED,
          actorType: "SYSTEM",
          payload: { paymentAttemptId: attempt._id, transactionId, amountPaise },
        },
      ],
      { session },
    );
    await consumeOrderStockReservationsOnce({
      tenantId,
      orderId: order._id,
      session,
      at: paidAt,
    });
    await EcommerceOrderEvent.create(
      [
        {
          _id: createId("eoev"),
          tenantId,
          orderId: order._id,
          type: EcommerceOrderEventType.STOCK_RELEASED,
          actorType: "SYSTEM",
          payload: { reason: "PAYMENT_CONFIRMED", paymentAttemptId: attempt._id },
        },
      ],
      { session },
    );
    await recordAttemptEvent({
      tenantId,
      orderId: order._id,
      paymentAttemptId: attempt._id,
      webhookEventId,
      direction: "INBOUND",
      outcome: "SUCCESS",
      reason: source,
      payload: providerPayload,
      session,
    });
    await enqueueEcommerceOutboxEvent({
      tenantId,
      topic: ECOMMERCE_OUTBOX_TOPICS.PAYMENT_SUCCEEDED,
      key: order._id,
      payload: {
        orderId: order._id,
        paymentAttemptId: attempt._id,
        transactionId,
        amountPaise,
        source,
      },
      session,
    });
    await postAssistedOrderCash(session, order, "ECOMMERCE_COUNTER_ORDER");
    return { outcome: "SUCCESS", orderId: order._id };
  });
}

export async function finalizeEcommercePaymentTerminalFailure({
  tenantId,
  merchantOrderId,
  transactionId,
  providerPayload,
  webhookEventId,
  reason,
  expectedIdentity,
}) {
  const attempt = await EcommercePaymentAttempt.findOne({
    tenantId,
    $or: [{ _id: merchantOrderId }, { merchantOrderId }, { providerOrderId: merchantOrderId }],
  }).lean();
  if (!attempt) return { outcome: "NOT_FOUND" };
  if (isBookingPayment(attempt)) {
    return finalizeBookingPaymentTerminalFailure({
      attempt, transactionId, providerPayload, webhookEventId, reason, expectedIdentity,
    });
  }
  if (attempt.status === EcommercePaymentAttemptStatus.SUCCEEDED) {
    return { outcome: "ALREADY_SUCCESS" };
  }

  return withTransaction(async (session) => {
    const updated = await EcommercePaymentAttempt.findOneAndUpdate(
      {
        _id: attempt._id,
        tenantId,
        status: { $in: [EcommercePaymentAttemptStatus.PENDING, EcommercePaymentAttemptStatus.INITIATED] },
        ...identityFilter(expectedIdentity),
      },
      {
        $set: {
          status: EcommercePaymentAttemptStatus.FAILED,
          failureReason: reason ?? "PROVIDER_TERMINAL_FAILURE",
          providerPaymentId: transactionId ?? attempt.providerPaymentId,
          providerPayload,
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    );
    if (!updated) {
      if (expectedIdentity) {
        const current = await EcommercePaymentAttempt.findById(attempt._id).session(session).lean();
        if (current && !sameIdentity(expectedIdentity, current)) return { outcome: IDENTITY_CHANGED };
      }
      return { outcome: "NOOP" };
    }
    await EcommerceOrderEvent.create(
      [
        {
          _id: createId("eoev"),
          tenantId,
          orderId: attempt.orderId,
          type: EcommerceOrderEventType.PAYMENT_FAILED,
          actorType: "SYSTEM",
          payload: { paymentAttemptId: attempt._id, transactionId },
        },
      ],
      { session },
    );
    await recordAttemptEvent({
      tenantId,
      orderId: attempt.orderId,
      paymentAttemptId: attempt._id,
      webhookEventId,
      direction: "INBOUND",
      outcome: "TERMINAL_FAILURE",
      reason,
      payload: providerPayload,
      session,
    });
    await enqueueEcommerceOutboxEvent({
      tenantId,
      topic: ECOMMERCE_OUTBOX_TOPICS.PAYMENT_FAILED,
      key: `${attempt.orderId}:${attempt._id}`,
      payload: { orderId: attempt.orderId, paymentAttemptId: attempt._id, reason },
      session,
    });
    return { outcome: "FAILED", orderId: attempt.orderId };
  });
}

export async function processEcommercePhonePeWebhook({
  tenantId,
  normalized,
  webhookEventId,
}) {
  const { reference, transactionId, payload, completed, failed } = normalized;
  if (!reference) return { handled: false };
  const { isEcommercePaymentMerchantOrderId } = await import("../lib/ecommerce-payment-reference.js");
  if (!isEcommercePaymentMerchantOrderId(reference)) return { handled: false };

  if (completed) {
    const verified = validatePhonePeCompletedIdentifiers({
      merchantOrderId: reference,
      normalized: {
        transactionId,
        amount: payload?.amount ?? normalized.amount,
      },
    });
    if (!verified.ok) {
      const attempt = await EcommercePaymentAttempt.findOne({
        tenantId,
        $or: [{ _id: reference }, { merchantOrderId: reference }, { providerOrderId: reference }],
      }).lean();
      await recordAttemptEvent({
        tenantId,
        orderId: attempt?.orderId ?? reference,
        paymentAttemptId: attempt?._id ?? reference,
        webhookEventId,
        direction: "INBOUND",
        outcome: "REJECTED",
        reason: verified.code,
        payload,
      });
      return { handled: true, result: { outcome: "REJECTED", code: verified.code } };
    }
    const result = await finalizeEcommercePaymentSuccess({
      tenantId,
      merchantOrderId: reference,
      transactionId: verified.transactionId,
      amountPaise: verified.amountPaise,
      currency: "INR",
      providerPayload: payload,
      webhookEventId,
    });
    return { handled: true, result };
  }
  if (failed) {
    const result = await finalizeEcommercePaymentTerminalFailure({
      tenantId,
      merchantOrderId: reference,
      transactionId,
      providerPayload: payload,
      webhookEventId,
      reason: normalized.type,
    });
    return { handled: true, result };
  }
  const attempt = await EcommercePaymentAttempt.findOne({
    tenantId,
    $or: [{ _id: reference }, { merchantOrderId: reference }, { providerOrderId: reference }],
  }).lean();
  await recordAttemptEvent({
    tenantId,
    orderId: attempt?.orderId ?? reference,
    paymentAttemptId: attempt?._id ?? reference,
    webhookEventId,
    direction: "INBOUND",
    outcome: "IGNORED",
    reason: normalized.type ?? "non_terminal",
    payload,
  });
  return { handled: true, result: { outcome: "IGNORED" } };
}
