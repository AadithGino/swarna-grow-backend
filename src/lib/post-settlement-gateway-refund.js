import { LedgerEntryType } from "../constants/enums.js";
import { createId } from "./ids.js";
import { LedgerEntry } from "../models/index.js";
import { nextSchemeLedgerSequence } from "../services/sequence.service.js";

/**
 * Records gateway refund on a terminal scheme: ledger reversal for audit, scheme adjustment totals,
 * without rebuilding live scheme projection (status remains MATURED/REDEEMED/CLOSED_PREMATURE).
 */
export async function recordPostSettlementGatewayRefund({
  session,
  payment,
  scheme,
  refundAmountPaise,
  weightDeltaMg,
  providerRefundId,
  paymentRefundId,
}) {
  const sequence = await nextSchemeLedgerSequence(
    payment.tenantId,
    payment.schemeId,
    session,
  );
  await LedgerEntry.create(
    [
      {
        _id: createId("ledger"),
        tenantId: payment.tenantId,
        branchId: payment.branchId,
        schemeId: payment.schemeId,
        customerId: payment.customerId,
        paymentId: payment._id,
        type: LedgerEntryType.REVERSAL,
        sequence,
        amountPaise: refundAmountPaise,
        weightMg: weightDeltaMg,
        ratePerGramPaise: payment.ratePerGramPaise,
        cycle: payment.targetCycle,
        actorType: "WEBHOOK",
        actorId: "phonepe-refund",
        reversalOf: payment._id,
        description: `Post-settlement gateway refund ${providerRefundId ?? ""}`.trim(),
        metadata: {
          postSettlementRefund: true,
          schemeStatusAtRefund: scheme.status,
          paymentRefundId,
          providerRefundId,
        },
      },
    ],
    { session },
  );

  scheme.postSettlementRefundedPaise =
    Number(scheme.postSettlementRefundedPaise ?? 0) + refundAmountPaise;
  scheme.postSettlementRefundedWeightMg =
    Number(scheme.postSettlementRefundedWeightMg ?? 0) + weightDeltaMg;
  scheme.version = Number(scheme.version ?? 0) + 1;
  await scheme.save({ session });
}
