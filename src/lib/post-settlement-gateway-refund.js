import { LedgerEntryType } from "../constants/enums.js";
import { createId } from "./ids.js";
import { LedgerEntry, PostSettlementRefundCase } from "../models/index.js";
import { nextSchemeLedgerSequence } from "../services/sequence.service.js";
import { ensurePostSettlementRefundCase } from "../services/post-settlement-refund-case.service.js";

/**
 * Idempotent post-settlement gateway refund accounting: audit ledger reversal, scheme totals, reconciliation case.
 */
export async function recordPostSettlementGatewayRefund({
  session,
  payment,
  scheme,
  paymentRefund,
  refundAmountPaise,
  weightDeltaMg,
  providerRefundId,
}) {
  const existing = await PostSettlementRefundCase.findOne({
    tenantId: payment.tenantId,
    paymentRefundId: paymentRefund._id,
  })
    .session(session)
    .lean();
  if (existing) return existing;

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
          paymentRefundId: paymentRefund._id,
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

  const { case: caseRow } = await ensurePostSettlementRefundCase({
    session,
    payment,
    scheme,
    paymentRefund,
    refundAmountPaise,
    weightDeltaMg,
    providerRefundId,
  });
  return caseRow;
}
