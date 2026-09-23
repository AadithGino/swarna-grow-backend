import { AlertType, GatewayRefundStatus } from "../constants/enums.js";
import { assertNonNegativeGatewayRefundReserved } from "./gateway-refundable-balance.js";
import { errors } from "./app-error.js";
import { upsertOperationalAlert } from "./operational-alert.js";
import { withTransaction } from "./transaction.js";
import { Payment, PaymentRefund } from "../models/index.js";

export async function decrementGatewayRefundReservation({
  tenantId,
  paymentId,
  releaseAmount,
  session,
  skipWhenNoReservation = false,
}) {
  if (!Number.isSafeInteger(releaseAmount) || releaseAmount <= 0) {
    return { releasedPaise: 0, skipped: true };
  }
  const current = await Payment.findOne({ _id: paymentId, tenantId }).session(session).lean();
  const reserved = current?.gatewayRefundReservedPaise ?? 0;
  if (reserved === 0) {
    if (skipWhenNoReservation) return { releasedPaise: 0, skipped: true };
  }
  const updated = await Payment.findOneAndUpdate(
    {
      _id: paymentId,
      tenantId,
      gatewayRefundReservedPaise: { $gte: releaseAmount },
    },
    { $inc: { gatewayRefundReservedPaise: -releaseAmount } },
    { session, new: true },
  );
  if (!updated) {
    throw errors.business(
      "GATEWAY_REFUND_RESERVATION_INCONSISTENT",
      "Gateway refund reservation balance is insufficient for release.",
      { paymentId, releaseAmount },
    );
  }
  assertNonNegativeGatewayRefundReserved(updated);
  return { releasedPaise: releaseAmount, payment: updated };
}

const RELEASABLE_REFUND_STATUSES = new Set([
  GatewayRefundStatus.PENDING,
  GatewayRefundStatus.PENDING_RECONCILIATION,
  GatewayRefundStatus.ACCEPTED,
]);

/**
 * Release gateway refund reservation exactly once for a failed/cancelled initiation.
 * Idempotent when reservation was already released or refund is terminal.
 */
export async function releaseGatewayRefundReservation({
  tenantId,
  paymentId,
  refundId,
  amountPaise,
  session: externalSession,
  failureStatus = GatewayRefundStatus.FAILED,
  reviewReason,
}) {
  const run = async (session) => {
    const refund = await PaymentRefund.findOne({ _id: refundId, tenantId, paymentId }).session(session);
    if (!refund) return { released: false, reason: "NOT_FOUND" };
    if (refund.status === GatewayRefundStatus.COMPLETED) {
      return { released: false, reason: "ALREADY_COMPLETED" };
    }
    if (
      refund.status === GatewayRefundStatus.FAILED
      && failureStatus === GatewayRefundStatus.FAILED
    ) {
      const payment = await Payment.findById(paymentId).session(session).lean();
      assertNonNegativeGatewayRefundReserved(payment ?? { gatewayRefundReservedPaise: 0 });
      return { released: false, reason: "ALREADY_FAILED" };
    }
    if (!RELEASABLE_REFUND_STATUSES.has(refund.status) && refund.status !== GatewayRefundStatus.FAILED) {
      return { released: false, reason: "NOT_RELEASABLE" };
    }

    const releaseAmount = amountPaise ?? refund.amountPaise ?? 0;
    const shouldReleaseReservation = RELEASABLE_REFUND_STATUSES.has(refund.status);
    if (shouldReleaseReservation && releaseAmount > 0) {
      try {
        await decrementGatewayRefundReservation({
          tenantId,
          paymentId,
          releaseAmount,
          session,
        });
      } catch (error) {
        if (error?.code === "GATEWAY_REFUND_RESERVATION_INCONSISTENT" && !externalSession) {
          await upsertOperationalAlert({
            tenantId,
            type: AlertType.GATEWAY_REFUND_INVALID,
            entityId: paymentId,
            title: "Gateway refund reservation inconsistency",
            message: error.message,
            metadata: { refundId, releaseAmount },
          });
        }
        throw error;
      }
    }

    await PaymentRefund.updateOne(
      {
        _id: refundId,
        tenantId,
        status: { $ne: GatewayRefundStatus.COMPLETED },
      },
      {
        $set: {
          status: failureStatus,
          failedAt: new Date(),
          ...(reviewReason ? { requiresReview: true, reviewReason } : {}),
        },
      },
      { session },
    );

    const payment = await Payment.findById(paymentId).session(session).lean();
    assertNonNegativeGatewayRefundReserved(payment ?? { gatewayRefundReservedPaise: 0 });
    return { released: true, reason: "RELEASED" };
  };

  if (externalSession) return run(externalSession);
  return withTransaction(run);
}

export async function markRefundPendingReconciliation({
  tenantId,
  refundId,
  providerInitiationError,
  attempts,
}) {
  await PaymentRefund.updateOne(
    { _id: refundId, tenantId, status: { $ne: GatewayRefundStatus.COMPLETED } },
    {
      $set: {
        status: GatewayRefundStatus.PENDING_RECONCILIATION,
        requiresReview: true,
        reviewReason: "REFUND_INITIATION_AMBIGUOUS",
        providerInitiationError: String(providerInitiationError ?? "ambiguous").slice(0, 500),
        lastInitiationAt: new Date(),
      },
      $inc: { providerInitiationAttempts: 1 },
    },
  );
  return { attempts, status: GatewayRefundStatus.PENDING_RECONCILIATION };
}

export function refundInitiationMayRetry(refund) {
  if (!refund) return false;
  if (refund.status === GatewayRefundStatus.COMPLETED) return false;
  if (refund.providerInitiationError) return true;
  if (refund.status === GatewayRefundStatus.PENDING_RECONCILIATION) return true;
  return (refund.providerInitiationAttempts ?? 0) === 0;
}
