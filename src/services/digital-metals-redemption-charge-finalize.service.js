import { validatePhonePeCompletedIdentifiers } from "../lib/phonepe-completed-identifiers.js";
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
  currency = "INR",
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
  if (String(currency).toUpperCase() !== "INR") return { outcome: "CURRENCY_MISMATCH", orderId: attempt.orderId };
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

    const currentAttempt = await DigitalMetalRedemptionPaymentAttempt.findById(attempt._id).session(session).lean();
    if (currentAttempt?.status === "SUCCEEDED") return { outcome: "ALREADY_SUCCESS", orderId: order._id };
    if (order.successfulChargeAttemptId || ["CHARGE_PAID", "FULFILMENT_ACCEPTED", "PACKING", "DISPATCHED", "PICKUP_READY", "INVESTIGATION", "COMPLETED"].includes(order.status)) {
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

export async function processDigitalMetalRedemptionChargePhonePeWebhook({ tenantId, normalized, payload }) {
  const reference = normalized?.reference ?? payload?.originalMerchantOrderId ?? payload?.merchantOrderId ?? payload?.data?.merchantOrderId;
  if (!reference || !isDigitalMetalRedemptionChargeMerchantOrderId(reference)) return { outcome: "IGNORED" };
  const body = normalized?.payload ?? payload;
  const completed = normalized?.completed ?? ["COMPLETED", "SUCCESS"].includes(String(body?.state ?? body?.code ?? "").toUpperCase());
  if (!completed) {
    if (normalized?.failed) {
      await DigitalMetalRedemptionPaymentAttempt.updateOne(
        { tenantId, merchantOrderId: reference, status: { $in: ["PENDING", "INITIATED"] } },
        { $set: { status: "FAILED", failureReason: normalized.type } },
      );
    }
    return { outcome: "NOT_COMPLETED" };
  }
  const verified = validatePhonePeCompletedIdentifiers({ merchantOrderId: reference, normalized: {
    transactionId: normalized?.transactionId ?? body?.transactionId ?? body?.data?.transactionId,
    amount: body?.amount ?? normalized?.amount ?? body?.data?.amount,
  } });
  if (!verified.ok) return { outcome: "REJECTED", code: verified.code };
  return finalizeDigitalMetalRedemptionChargeSuccess({ tenantId, merchantOrderId: reference,
    transactionId: verified.transactionId, amountPaise: verified.amountPaise,
    currency: body?.currency ?? "INR", providerPayload: body, source: "WEBHOOK" });
}
