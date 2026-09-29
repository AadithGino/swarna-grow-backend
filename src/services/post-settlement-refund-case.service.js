import {
  PostSettlementRefundCase,
  Redemption,
} from "../models/index.js";
import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { PostSettlementRefundCaseStatus } from "../constants/enums.js";
import { writeAudit } from "./audit.service.js";
import { AuditEntityType } from "../constants/enums.js";
import { withTransaction } from "../lib/transaction.js";

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

function caseScopeFilter(req) {
  const filter = {};
  if (req.scope?.branchId) filter.branchId = req.scope.branchId;
  return filter;
}

export async function listPostSettlementRefundCases(req) {
  const filter = {
    tenantId: req.auth.tenantId,
    ...caseScopeFilter(req),
    ...(req.query.status ? { status: req.query.status } : {}),
  };
  const [rows, pendingCount] = await Promise.all([
    PostSettlementRefundCase.find(filter).sort({ refundCompletedAt: -1 }).lean(),
    PostSettlementRefundCase.countDocuments({
      tenantId: req.auth.tenantId,
      ...caseScopeFilter(req),
      status: PostSettlementRefundCaseStatus.PENDING_RESOLUTION,
    }),
  ]);
  return { data: rows, meta: { total: rows.length, pendingCount } };
}

export async function getPostSettlementRefundCase(req) {
  const row = await PostSettlementRefundCase.findOne({
    _id: req.params.caseId,
    tenantId: req.auth.tenantId,
    ...caseScopeFilter(req),
  }).lean();
  if (!row) throw errors.notFound("Post-settlement refund case");
  return row;
}

export async function resolvePostSettlementRefundCase(req) {
  const { disposition, reason, expectedVersion } = req.body;
  if (expectedVersion == null || !Number.isInteger(Number(expectedVersion)) || Number(expectedVersion) < 0) {
    throw new AppError("VALIDATION_FAILED", "expectedVersion is required.", 422);
  }
  if (!disposition) {
    throw new AppError("VALIDATION_FAILED", "disposition is required.", 422);
  }
  if (!String(reason ?? "").trim()) {
    throw new AppError("VALIDATION_FAILED", "reason is required.", 422);
  }

  return withTransaction(async (session) => {
    const filter = {
      _id: req.params.caseId,
      tenantId: req.auth.tenantId,
      status: PostSettlementRefundCaseStatus.PENDING_RESOLUTION,
      version: Number(expectedVersion),
      ...caseScopeFilter(req),
    };
    const before = await PostSettlementRefundCase.findOne(filter).session(session).lean();
    if (!before) {
      const existing = await PostSettlementRefundCase.findOne({
        _id: req.params.caseId,
        tenantId: req.auth.tenantId,
        ...caseScopeFilter(req),
      })
        .session(session)
        .lean();
      if (!existing) throw errors.notFound("Post-settlement refund case");
      if (existing.status === PostSettlementRefundCaseStatus.RESOLVED) {
        if (Number(expectedVersion) < Number(existing.version ?? 0)) {
          throw errors.conflict("VERSION_CONFLICT", "Case changed. Refresh and try again.");
        }
        throw errors.business("CASE_ALREADY_RESOLVED", "This case is already resolved.");
      }
      throw errors.conflict("VERSION_CONFLICT", "Case changed. Refresh and try again.");
    }

    const updated = await PostSettlementRefundCase.findOneAndUpdate(
      filter,
      {
        $set: {
          status: PostSettlementRefundCaseStatus.RESOLVED,
          disposition,
          resolutionReason: String(reason).trim(),
          resolvedBy: req.auth.id,
          resolvedAt: new Date(),
        },
        $inc: { version: 1 },
      },
      { new: true, session },
    );
    if (!updated) {
      throw errors.conflict("VERSION_CONFLICT", "Case changed. Refresh and try again.");
    }

    await writeAudit({
      req,
      action: "POST_SETTLEMENT_REFUND_RESOLVED",
      entityType: AuditEntityType.PAYMENT,
      entityId: updated.paymentId,
      before,
      after: updated.toObject(),
      metadata: { caseId: updated._id, disposition },
      session,
    });

    return updated.toObject();
  });
}
