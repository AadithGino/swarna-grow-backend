import { withTransaction } from "../lib/transaction.js";
import { isDigitalMetalRedemptionChargeMerchantOrderId } from "../lib/digital-metals-payment-reference.js";
import {
  DigitalMetalRedemptionOrder,
  DigitalMetalRedemptionPaymentAttempt,
} from "../models/index.js";
import { ensureRedemptionChargeRefundCase } from "./digital-metals-redemption-charge-refund.service.js";
import { enqueueRedemptionCustomerNotice } from "../lib/digital-metals-customer-notice.js";

export function mapRedemptionOrderPaymentDto(order, attempts = []) {
  return {
    id: order._id,
    status: order.status,
    chargeTotalPaise: order.chargeTotalPaise,
    chargePaymentExpiresAt: order.chargePaymentExpiresAt,
    chargePaidAt: order.chargePaidAt ?? null,
    quantityUg: String(order.quantityUg),
    paymentExceptionStatus: order.paymentExceptionStatus ?? null,
    paymentAttempts: attempts.map((a) => ({
      id: a._id,
      status: a.status,
      amountPaise: a.amountPaise,
      merchantOrderId: a.merchantOrderId ?? a._id,
    })),
  };
}

export async function finalizeDigitalMetalRedemptionChargeSuccess({
  tenantId,
  merchantOrderId,
  transactionId,
  amountPaise,
  currency: _currency = "INR",
  providerPayload,
  source = "WEBHOOK",
}) {
  const attempt = await DigitalMetalRedemptionPaymentAttempt.findOne({
    tenantId,
    $or: [{ _id: merchantOrderId }, { merchantOrderId }],
  }).lean();
  if (!attempt) return { outcome: "NOT_FOUND" };
  if (attempt.status === "SUCCEEDED") {
    return { outcome: "ALREADY_SUCCESS", orderId: attempt.orderId };
  }
  if (Number(attempt.amountPaise) !== Number(amountPaise)) {
    return { outcome: "AMOUNT_MISMATCH", orderId: attempt.orderId };
  }
  if (transactionId) {
    const replayTxn = await DigitalMetalRedemptionPaymentAttempt.findOne({
      tenantId,
      orderId: attempt.orderId,
      providerPaymentId: transactionId,
      status: "SUCCEEDED",
    }).lean();
    if (replayTxn && replayTxn._id !== attempt._id) {
      return { outcome: "ALREADY_SUCCESS", orderId: attempt.orderId, replayTransaction: true };
    }
  }

  return withTransaction(async (session) => {
    const order = await DigitalMetalRedemptionOrder.findOne({
      _id: attempt.orderId,
      tenantId,
    }).session(session);
    if (!order) return { outcome: "ORDER_NOT_FOUND" };

    if (order.status === "CHARGE_PAID") {
      if (order.successfulChargeAttemptId === attempt._id) {
        await DigitalMetalRedemptionPaymentAttempt.updateOne(
          { _id: attempt._id, status: { $ne: "SUCCEEDED" } },
          {
            $set: {
              status: "SUCCEEDED",
              providerPaymentId: transactionId,
              providerPayload,
            },
          },
          { session },
        );
        return { outcome: "ALREADY_SUCCESS", orderId: order._id };
      }
      await DigitalMetalRedemptionPaymentAttempt.updateOne(
        { _id: attempt._id, status: { $ne: "SUCCEEDED" } },
        {
          $set: {
            status: "SUCCEEDED",
            providerPaymentId: transactionId,
            providerPayload,
            failureReason: "ADDITIONAL_CAPTURE_REFUND_REVIEW",
          },
        },
        { session },
      );
      await DigitalMetalRedemptionOrder.updateOne(
        { _id: order._id },
        {
          $set: {
            paymentExceptionStatus: "ADDITIONAL_CAPTURE",
            paymentExceptionPayload: {
              paymentAttemptId: attempt._id,
              winningAttemptId: order.successfulChargeAttemptId,
              transactionId,
              source,
            },
          },
          $inc: { version: 1 },
        },
        { session },
      );
      await ensureRedemptionChargeRefundCase(session, {
        tenantId,
        order,
        paymentAttemptId: attempt._id,
        merchantOrderId: attempt.merchantOrderId ?? attempt._id,
        amountPaise: attempt.amountPaise,
        exceptionType: "ADDITIONAL_CAPTURE",
      });
      return { outcome: "ADDITIONAL_CAPTURE_REVIEW", orderId: order._id };
    }

    const now = new Date();
    const windowOpen = now.getTime() <= new Date(order.chargePaymentExpiresAt).getTime();
    const reservationReleased = ["EXPIRED", "CANCELLED"].includes(order.status);

    if (!windowOpen || reservationReleased) {
      await DigitalMetalRedemptionPaymentAttempt.updateOne(
        { _id: attempt._id },
        {
          $set: {
            status: "SUCCEEDED",
            providerPaymentId: transactionId,
            providerPayload,
            failureReason: "LATE_CHARGE_SUCCESS_REFUND_REVIEW",
          },
        },
        { session },
      );
      await DigitalMetalRedemptionOrder.updateOne(
        { _id: order._id },
        {
          $set: {
            status: "REFUND_REVIEW",
            paymentExceptionStatus: "LATE_SUCCESS",
            paymentExceptionPayload: { paymentAttemptId: attempt._id, source, at: now.toISOString() },
          },
          $inc: { version: 1 },
        },
        { session },
      );
      await ensureRedemptionChargeRefundCase(session, {
        tenantId,
        order,
        paymentAttemptId: attempt._id,
        merchantOrderId: attempt.merchantOrderId ?? attempt._id,
        amountPaise: attempt.amountPaise,
        exceptionType: "LATE_SUCCESS",
      });
      return { outcome: "LATE_CHARGE_REVIEW", orderId: order._id };
    }

    if (order.status !== "CHARGE_PENDING") {
      return { outcome: "INVALID_STATE", orderId: order._id, status: order.status };
    }

    await DigitalMetalRedemptionPaymentAttempt.updateOne(
      { _id: attempt._id, status: { $ne: "SUCCEEDED" } },
      {
        $set: {
          status: "SUCCEEDED",
          providerPaymentId: transactionId,
          providerPayload,
        },
      },
      { session },
    );

    await DigitalMetalRedemptionOrder.updateOne(
      { _id: order._id, status: "CHARGE_PENDING" },
      {
        $set: {
          status: "CHARGE_PAID",
          successfulChargeAttemptId: attempt._id,
          chargePaidAt: now,
        },
        $inc: { version: 1 },
      },
      { session },
    );

    await enqueueRedemptionCustomerNotice(session, {
      tenantId,
      orderId: order._id,
      customerId: order.customerId,
      transition: "CHARGE_PAID",
      eventAt: now,
    });

    return { outcome: "CHARGE_PAID", orderId: order._id };
  });
}

export async function processDigitalMetalRedemptionChargePhonePeWebhook({ tenantId, payload }) {
  const reference =
    payload?.merchantOrderId ?? payload?.data?.merchantOrderId ?? payload?.merchantTransactionId ?? null;
  if (!reference || !isDigitalMetalRedemptionChargeMerchantOrderId(reference)) {
    return { outcome: "IGNORED" };
  }
  const state = String(payload?.state ?? payload?.code ?? "").toUpperCase();
  const completed = state.includes("COMPLETED") || state.includes("SUCCESS");
  if (!completed) return { outcome: "NOT_COMPLETED" };
  const amountPaise = Number(payload?.amount ?? payload?.data?.amount ?? 0);
  return finalizeDigitalMetalRedemptionChargeSuccess({
    tenantId,
    merchantOrderId: reference,
    transactionId: payload?.transactionId ?? payload?.data?.transactionId ?? reference,
    amountPaise,
    providerPayload: payload,
    source: "WEBHOOK",
  });
}
