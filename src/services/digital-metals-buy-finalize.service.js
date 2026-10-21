import {
  buildDigitalMetalPurchaseSummary,
  purchaseSummaryForJournalMetadata,
} from "../lib/digital-metals-purchase-summary.js";
import { validatePhonePeCompletedIdentifiers } from "../lib/phonepe-completed-identifiers.js";
import { withTransaction } from "../lib/transaction.js";
import {
  DIGITAL_METAL_OUTBOX_TOPICS,
  enqueueDigitalMetalOutboxEvent,
} from "../lib/digital-metals-outbox.js";
import { isDigitalMetalBuyPaymentMerchantOrderId } from "../lib/digital-metals-payment-reference.js";
import { maybePauseBeforeDigitalMetalBuyCreditForTests } from "../lib/digital-metals-buy-finalize-test-hooks.js";
import { creditWalletFromPurchase } from "./digital-metals-ledger.service.js";
import { ensureDigitalMetalPaymentExceptionRefundCase } from "./digital-metals-payment-exception.service.js";
import {
  DigitalMetalBuyOrder,
  DigitalMetalBuyPaymentAttempt,
} from "../models/index.js";

export function mapBuyOrderStatusDto(order, attempts = []) {
  const successful =
    attempts.find((a) => a._id === order.successfulPaymentAttemptId)
    ?? attempts.find((a) => a.status === "SUCCEEDED")
    ?? null;
  return {
    id: order._id,
    status: order.status,
    metal: order.metal,
    finenessPpm: order.finenessPpm,
    quantityUg: String(order.quantityUg),
    totalPayablePaise: order.totalPayablePaise,
    quoteExpiresAt: order.quoteExpiresAt,
    paymentAcceptanceExpiresAt: order.paymentAcceptanceExpiresAt,
    bookedAt: order.termsAcceptedAt ?? order.createdAt ?? null,
    createdAt: order.createdAt ?? null,
    creditedAt: order.creditedAt ?? null,
    creditJournalId: order.creditJournalId ?? null,
    invoiceStatus: order.invoiceStatus ?? "PENDING",
    paymentExceptionStatus: order.paymentExceptionStatus ?? null,
    snapshot: order.snapshot ?? null,
    purchaseSummary: buildDigitalMetalPurchaseSummary(order, successful),
    paymentAttempts: attempts.map((a) => ({
      id: a._id,
      status: a.status,
      amountPaise: a.amountPaise,
      merchantOrderId: a.merchantOrderId ?? a._id,
      providerPaymentId: a.providerPaymentId ?? null,
      failureReason: a.failureReason ?? null,
      paidAt: a.status === "SUCCEEDED" ? (a.updatedAt ?? null) : null,
    })),
  };
}

export async function finalizeDigitalMetalBuyPaymentSuccess({
  tenantId,
  merchantOrderId,
  transactionId,
  amountPaise,
  currency = "INR",
  providerPayload,
  webhookEventId,
  source = "WEBHOOK",
}) {
  const attempt = await DigitalMetalBuyPaymentAttempt.findOne({
    tenantId,
    $or: [{ _id: merchantOrderId }, { merchantOrderId }, { providerOrderId: merchantOrderId }],
  }).lean();
  if (!attempt) return { outcome: "NOT_FOUND" };
  if (attempt.status === "SUCCEEDED") {
    return { outcome: "ALREADY_SUCCESS", orderId: attempt.orderId };
  }
  if (String(attempt.currency ?? "INR") !== String(currency ?? "INR")) {
    return { outcome: "CURRENCY_MISMATCH", orderId: attempt.orderId };
  }
  if (Number(attempt.amountPaise) !== Number(amountPaise)) {
    return { outcome: "AMOUNT_MISMATCH", orderId: attempt.orderId };
  }

  return withTransaction(async (session) => {
    const order = await DigitalMetalBuyOrder.findOne({
      _id: attempt.orderId,
      tenantId,
    }).session(session);
    if (!order) return { outcome: "ORDER_NOT_FOUND" };

    if (order.status === "CREDITED") {
      return { outcome: "ALREADY_SUCCESS", orderId: order._id };
    }

    const now = new Date();
    const paymentWindowOpen = now.getTime() <= new Date(order.paymentAcceptanceExpiresAt).getTime();
    const lateSuccess = !paymentWindowOpen && order.status !== "PAYMENT_VERIFIED";

    if (lateSuccess) {
      await DigitalMetalBuyPaymentAttempt.updateOne(
        { _id: attempt._id },
        {
          $set: {
            status: "SUCCEEDED",
            providerPaymentId: transactionId,
            providerPayload,
            failureReason: "LATE_SUCCESS_REFUND_REVIEW",
          },
          $inc: { version: 1 },
        },
        { session },
      );
      await DigitalMetalBuyOrder.updateOne(
        { _id: order._id, status: { $nin: ["CREDITED", "REFUNDED"] } },
        {
          $set: {
            status: "REFUND_REVIEW",
            paymentExceptionStatus: "LATE_SUCCESS",
            paymentExceptionPayload: {
              paymentAttemptId: attempt._id,
              transactionId,
              amountPaise,
              webhookEventId,
              source,
              at: now.toISOString(),
            },
          },
          $inc: { version: 1 },
        },
        { session },
      );
      await enqueueDigitalMetalOutboxEvent({
        tenantId,
        topic: DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_PAYMENT_FAILED,
        key: `${order._id}:late-success`,
        payload: { orderId: order._id, reason: "LATE_SUCCESS" },
        session,
      });
      await ensureDigitalMetalPaymentExceptionRefundCase(session, {
        tenantId,
        order,
        paymentAttemptId: attempt._id,
        merchantOrderId: attempt.merchantOrderId ?? attempt._id,
        amountPaise: attempt.amountPaise,
        exceptionType: "LATE_SUCCESS",
      });
      return { outcome: "LATE_SUCCESS_REVIEW", orderId: order._id };
    }

    if (order.successfulPaymentAttemptId && order.successfulPaymentAttemptId !== attempt._id) {
      await DigitalMetalBuyPaymentAttempt.updateOne(
        { _id: attempt._id, status: { $ne: "SUCCEEDED" } },
        {
          $set: {
            status: "SUCCEEDED",
            providerPaymentId: transactionId,
            providerPayload,
            failureReason: "DUPLICATE_PAYMENT",
          },
          $inc: { version: 1 },
        },
        { session },
      );
      await DigitalMetalBuyOrder.updateOne(
        { _id: order._id },
        {
          $set: {
            paymentExceptionStatus: "DUPLICATE_PAYMENT_REFUND_REQUIRED",
            paymentExceptionPayload: {
              paymentAttemptId: attempt._id,
              winningAttemptId: order.successfulPaymentAttemptId,
              transactionId,
            },
          },
          $inc: { version: 1 },
        },
        { session },
      );
      await ensureDigitalMetalPaymentExceptionRefundCase(session, {
        tenantId,
        order,
        paymentAttemptId: attempt._id,
        merchantOrderId: attempt.merchantOrderId ?? attempt._id,
        amountPaise: attempt.amountPaise,
        exceptionType: "DUPLICATE_PAYMENT",
      });
      return { outcome: "DUPLICATE_PAYMENT", orderId: order._id };
    }

    await DigitalMetalBuyPaymentAttempt.updateOne(
      { _id: attempt._id, status: { $ne: "SUCCEEDED" } },
      {
        $set: {
          status: "SUCCEEDED",
          providerPaymentId: transactionId,
          providerPayload,
        },
        $inc: { version: 1 },
      },
      { session },
    );

    await DigitalMetalBuyOrder.updateOne(
      { _id: order._id, status: { $nin: ["CREDITED", "REFUNDED"] } },
      {
        $set: {
          status: "PAYMENT_VERIFIED",
          successfulPaymentAttemptId: attempt._id,
        },
        $inc: { version: 1 },
      },
      { session },
    );

    await maybePauseBeforeDigitalMetalBuyCreditForTests();
    const freshAttempt = await DigitalMetalBuyPaymentAttempt.findById(attempt._id).session(session).lean();
    const credited = await creditWalletFromPurchase(session, {
      tenantId,
      customerId: order.customerId,
      metal: order.metal,
      finenessPpm: order.finenessPpm,
      quantityUg: order.quantityUg,
      orderId: order._id,
      idempotencyKey: `purchase-credit:${order._id}`,
      metadata: purchaseSummaryForJournalMetadata(order, freshAttempt ?? attempt),
    });

    await DigitalMetalBuyOrder.updateOne(
      { _id: order._id, status: { $ne: "CREDITED" } },
      {
        $set: {
          status: "CREDITED",
          creditJournalId: credited.journalId,
          creditedAt: now,
        },
        $inc: { version: 1 },
      },
      { session },
    );

    await enqueueDigitalMetalOutboxEvent({
      tenantId,
      topic: DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_CREDITED,
      key: order._id,
      payload: {
        orderId: order._id,
        customerId: order.customerId,
        journalId: credited.journalId,
        quantityUg: order.quantityUg,
      },
      session,
    });
    await enqueueDigitalMetalOutboxEvent({
      tenantId,
      topic: DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_INVOICE_REQUEST,
      key: `${order._id}:invoice`,
      payload: { orderId: order._id },
      session,
    });

    return { outcome: "CREDITED", orderId: order._id, journalId: credited.journalId };
  });
}

export async function finalizeDigitalMetalBuyPaymentTerminalFailure({
  tenantId,
  merchantOrderId,
  transactionId,
  providerPayload,
  webhookEventId: _webhookEventId,
  reason,
}) {
  const attempt = await DigitalMetalBuyPaymentAttempt.findOne({
    tenantId,
    $or: [{ _id: merchantOrderId }, { merchantOrderId }, { providerOrderId: merchantOrderId }],
  }).lean();
  if (!attempt) return { outcome: "NOT_FOUND" };
  if (attempt.status === "SUCCEEDED") return { outcome: "ALREADY_SUCCESS", orderId: attempt.orderId };

  return withTransaction(async (session) => {
    await DigitalMetalBuyPaymentAttempt.updateOne(
      { _id: attempt._id, status: { $nin: ["SUCCEEDED"] } },
      {
        $set: {
          status: "FAILED",
          providerPaymentId: transactionId ?? null,
          providerPayload: providerPayload ?? {},
          failureReason: reason ?? "TERMINAL_FAILURE",
        },
        $inc: { version: 1 },
      },
      { session },
    );
    const order = await DigitalMetalBuyOrder.findOne({ _id: attempt.orderId, tenantId }).session(session).lean();
    await DigitalMetalBuyOrder.updateOne(
      {
        _id: attempt.orderId,
        tenantId,
        status: { $in: ["QUOTE_ACCEPTED", "PAYMENT_PENDING"] },
      },
      {
        $set: { status: "PAYMENT_FAILED" },
        $inc: { version: 1 },
      },
      { session },
    );
    if (order?.customerId) {
      await enqueueDigitalMetalOutboxEvent({
        tenantId,
        topic: DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_PAYMENT_FAILED,
        key: `${attempt.orderId}:terminal-failure`,
        payload: { orderId: attempt.orderId, customerId: order.customerId, reason: reason ?? "TERMINAL_FAILURE" },
        session,
      });
    }
    return { outcome: "FAILED", orderId: attempt.orderId };
  });
}

/** Idempotent credit completion when payment was verified but wallet credit did not commit. */
export async function recoverDigitalMetalBuyOrderCredit(orderId, tenantId) {
  const order = await DigitalMetalBuyOrder.findOne({ _id: orderId, tenantId }).lean();
  if (!order) return { outcome: "ORDER_NOT_FOUND" };
  if (order.status === "CREDITED") return { outcome: "ALREADY_CREDITED", orderId };
  if (!order.successfulPaymentAttemptId && order.status !== "PAYMENT_VERIFIED") {
    const attempt = await DigitalMetalBuyPaymentAttempt.findOne({
      tenantId,
      orderId,
      status: "SUCCEEDED",
    }).lean();
    if (!attempt) return { outcome: "NOT_RECOVERABLE", orderId };
    await DigitalMetalBuyOrder.updateOne(
      { _id: orderId, tenantId, successfulPaymentAttemptId: null },
      {
        $set: {
          status: "PAYMENT_VERIFIED",
          successfulPaymentAttemptId: attempt._id,
        },
        $inc: { version: 1 },
      },
    );
  }
  return withTransaction(async (session) => {
    const fresh = await DigitalMetalBuyOrder.findOne({ _id: orderId, tenantId }).session(session);
    if (!fresh) return { outcome: "ORDER_NOT_FOUND" };
    if (fresh.status === "CREDITED") return { outcome: "ALREADY_CREDITED", orderId };
    const attempt = await DigitalMetalBuyPaymentAttempt.findOne({
      tenantId,
      orderId: fresh._id,
      status: "SUCCEEDED",
    })
      .session(session)
      .lean();
    const credited = await creditWalletFromPurchase(session, {
      tenantId,
      customerId: fresh.customerId,
      metal: fresh.metal,
      finenessPpm: fresh.finenessPpm,
      quantityUg: fresh.quantityUg,
      orderId: fresh._id,
      idempotencyKey: `purchase-credit:${fresh._id}`,
      metadata: purchaseSummaryForJournalMetadata(fresh, attempt),
    });
    await DigitalMetalBuyOrder.updateOne(
      { _id: fresh._id, status: { $ne: "CREDITED" } },
      {
        $set: {
          status: "CREDITED",
          creditJournalId: credited.journalId,
          creditedAt: new Date(),
        },
        $inc: { version: 1 },
      },
      { session },
    );
    await enqueueDigitalMetalOutboxEvent({
      tenantId,
      topic: DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_CREDITED,
      key: fresh._id,
      payload: {
        orderId: fresh._id,
        customerId: fresh.customerId,
        journalId: credited.journalId,
        quantityUg: fresh.quantityUg,
        recovery: true,
      },
      session,
    });
    await enqueueDigitalMetalOutboxEvent({
      tenantId,
      topic: DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_INVOICE_REQUEST,
      key: `${fresh._id}:invoice`,
      payload: { orderId: fresh._id },
      session,
    });
    return { outcome: "CREDITED", orderId, journalId: credited.journalId, recovery: true };
  });
}

export async function processDigitalMetalBuyPhonePeWebhook({
  tenantId,
  normalized,
  webhookEventId,
}) {
  const { reference, transactionId, payload, completed, failed } = normalized;
  if (!reference || !isDigitalMetalBuyPaymentMerchantOrderId(reference)) {
    return { handled: false };
  }
  if (completed) {
    const verified = validatePhonePeCompletedIdentifiers({
      merchantOrderId: reference,
      normalized: {
        transactionId,
        amount: payload?.amount ?? normalized.amount,
      },
    });
    if (!verified.ok) {
      return { handled: true, result: { outcome: "REJECTED", code: verified.code } };
    }
    const result = await finalizeDigitalMetalBuyPaymentSuccess({
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
    const result = await finalizeDigitalMetalBuyPaymentTerminalFailure({
      tenantId,
      merchantOrderId: reference,
      transactionId,
      providerPayload: payload,
      webhookEventId,
      reason: normalized.type,
    });
    return { handled: true, result };
  }
  return { handled: true, result: { outcome: "IGNORED" } };
}
