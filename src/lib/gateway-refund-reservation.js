import { GatewayRefundStatus } from "../constants/enums.js";
import { assertNonNegativeGatewayRefundReserved } from "./gateway-refundable-balance.js";
import { withTransaction } from "./transaction.js";
import { Payment, PaymentRefund } from "../models/index.js";

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
      await Payment.updateOne(
        { _id: paymentId, tenantId },
        [
          {
            $set: {
              gatewayRefundReservedPaise: {
                $max: [
                  0,
                  {
                    $subtract: [
                      { $ifNull: ["$gatewayRefundReservedPaise", 0] },
                      releaseAmount,
                    ],
                  },
                ],
              },
            },
          },
        ],
        { session },
      );
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
