import {
  PostSettlementRefundCase,
  Redemption,
} from "../models/index.js";
import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { PostSettlementRefundCaseStatus } from "../constants/enums.js";
import { writeAudit } from "./audit.service.js";
import { AuditEntityType } from "../constants/enums.js";

export async function ensurePostSettlementRefundCase({
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
  if (existing) return { case: existing, created: false };

  const redemption = await Redemption.findOne({
    tenantId: payment.tenantId,
    schemeId: scheme._id,
    status: "COMPLETED",
  })
    .sort({ completedAt: -1 })
    .session(session)
    .lean();

  const completedAt = paymentRefund.completedAt ?? new Date();
  const row = (
    await PostSettlementRefundCase.create(
      [
        {
          _id: createId("psrc"),
          tenantId: payment.tenantId,
          branchId: payment.branchId,
          paymentRefundId: paymentRefund._id,
          providerRefundId,
          schemeId: scheme._id,
          paymentId: payment._id,
          customerId: payment.customerId,
          redemptionId: redemption?._id,
          refundAmountPaise,
          refundWeightMg: weightDeltaMg,
          refundCompletedAt: completedAt,
          settlementSnapshot: {
            schemeStatus: scheme.status,
            settlementCompletedAt: scheme.settlementCompletedAt,
            settlementPrincipalPaise: scheme.settlementPrincipalPaise,
            redemptionMode: redemption?.mode,
            redemptionSettlementPaise: redemption?.settlementPaise,
            redemptionCompletedAt: redemption?.completedAt,
          },
          status: PostSettlementRefundCaseStatus.PENDING_RESOLUTION,
        },
      ],
      { session },
    )
  )[0];
  return { case: row.toObject(), created: true };
}

export async function listPostSettlementRefundCases(req) {
  const filter = {
    tenantId: req.auth.tenantId,
    ...req.scope,
    ...(req.query.status ? { status: req.query.status } : {}),
  };
  const rows = await PostSettlementRefundCase.find(filter)
    .sort({ refundCompletedAt: -1 })
    .lean();
  return { data: rows, meta: { total: rows.length } };
}

export async function getPostSettlementRefundCase(req) {
  const row = await PostSettlementRefundCase.findOne({
    _id: req.params.caseId,
    tenantId: req.auth.tenantId,
    ...req.scope,
  }).lean();
  if (!row) throw errors.notFound("Post-settlement refund case");
  return row;
}

export async function resolvePostSettlementRefundCase(req) {
  const { disposition, reason, expectedVersion } = req.body;
  if (!disposition) {
    throw new AppError("VALIDATION_FAILED", "disposition is required.", 422);
  }
  const row = await PostSettlementRefundCase.findOne({
    _id: req.params.caseId,
    tenantId: req.auth.tenantId,
    ...req.scope,
  });
  if (!row) throw errors.notFound("Post-settlement refund case");
  if (expectedVersion != null && Number(expectedVersion) !== row.version) {
    throw errors.conflict("VERSION_CONFLICT", "Case changed. Refresh and try again.");
  }
  if (row.status === PostSettlementRefundCaseStatus.RESOLVED) {
    throw errors.business("CASE_ALREADY_RESOLVED", "This case is already resolved.");
  }
  const before = row.toObject();
  row.status = PostSettlementRefundCaseStatus.RESOLVED;
  row.disposition = disposition;
  row.resolutionReason = reason;
  row.resolvedBy = req.auth.id;
  row.resolvedAt = new Date();
  row.version += 1;
  await row.save();
  await writeAudit({
    req,
    action: "POST_SETTLEMENT_REFUND_RESOLVED",
    entityType: AuditEntityType.PAYMENT,
    entityId: row.paymentId,
    before,
    after: row.toObject(),
    metadata: { caseId: row._id, disposition },
  });
  return row.toObject();
}
