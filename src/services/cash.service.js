import { AuditEntityType, CashAdjustmentDirection, CashHandoverStatus, HandoverInitiator, PaymentMode, PaymentStatus } from "../constants/enums.js";
import { CashAdjustment, CashHandover, Payment } from "../models/index.js";
import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { writeAudit } from "./audit.service.js";
import { paginate } from "../lib/pagination.js";

async function sumAggregate(model, pipeline, session) {
  const query = model.aggregate(pipeline);
  if (session) query.session(session);
  const [row] = await query;
  return row?.amountPaise ?? 0;
}

export async function cashBalance({ tenantId, branchId, staffId }, session) {
  const paymentMatch = { tenantId, mode: PaymentMode.CASH, status: PaymentStatus.SUCCESS, collectedBy: staffId, ...(branchId ? { branchId } : {}) };
  const handoverBase = { tenantId, staffId, ...(branchId ? { branchId } : {}) };
  const adjustmentMatch = { tenantId, staffId, ...(branchId ? { branchId } : {}) };
  const cashCollectedPaise = await sumAggregate(Payment, [{ $match: paymentMatch }, { $group: { _id: null, amountPaise: { $sum: "$amountPaise" } } }], session);
  const acceptedPaise = await sumAggregate(CashHandover, [{ $match: { ...handoverBase, status: CashHandoverStatus.ACCEPTED } }, { $group: { _id: null, amountPaise: { $sum: "$amountPaise" } } }], session);
  const discrepancyAcceptedPaise = await sumAggregate(CashHandover, [{ $match: { ...handoverBase, status: CashHandoverStatus.DISCREPANCY } }, { $group: { _id: null, amountPaise: { $sum: { $ifNull: ["$acceptedAmountPaise", { $subtract: ["$amountPaise", { $ifNull: ["$discrepancyPaise", 0] }] }] } } } }], session);
  const cashPendingAcceptancePaise = await sumAggregate(CashHandover, [{ $match: { ...handoverBase, status: CashHandoverStatus.PENDING } }, { $group: { _id: null, amountPaise: { $sum: "$amountPaise" } } }], session);
  const adjustmentPaise = await sumAggregate(CashAdjustment, [{ $match: adjustmentMatch }, { $group: { _id: null, amountPaise: { $sum: { $cond: [{ $eq: ["$direction", CashAdjustmentDirection.CREDIT] }, "$amountPaise", { $multiply: ["$amountPaise", -1] }] } } } }], session);
  const handedOverPaise = acceptedPaise + discrepancyAcceptedPaise;
  const cashInHandPaise = cashCollectedPaise + adjustmentPaise - handedOverPaise - cashPendingAcceptancePaise;
  return { cashCollectedPaise, cashInHandPaise, cashPendingAcceptancePaise, collectedPaise: cashCollectedPaise, handedOverPaise, adjustmentPaise };
}

export async function createHandover(req, initiator) {
  return withTransaction(async (session) => {
    const staffId = initiator === HandoverInitiator.STAFF ? req.auth.id : req.body.staffId; const branchId = req.scope.branchId ?? req.body.branchId;
    const balance = await cashBalance({ tenantId: req.auth.tenantId, branchId, staffId }, session);
    if (req.body.amountPaise > balance.cashInHandPaise) throw errors.business("CASH_HANDOVER_AMOUNT_EXCEEDS_BALANCE", "The handover exceeds this staff member's cash-in-hand balance.", balance);
    const row = (await CashHandover.create([{ _id: createId("handover"), tenantId: req.auth.tenantId, branchId, staffId, amountPaise: req.body.amountPaise, remarks: req.body.remarks, initiator, submittedAt: new Date() }], { session }))[0];
    const afterBalance = await cashBalance({ tenantId: req.auth.tenantId, branchId, staffId }, session);
    const auditEventId = await writeAudit({ req, action: "CASH_HANDOVER_CREATED", entityType: AuditEntityType.CASH_HANDOVER, entityId: row._id, after: row.toObject(), session });
    return { ...row.toObject(), auditEventId, balance: afterBalance };
  });
}
export async function settleHandover(req, action) {
  return withTransaction(async (session) => {
    const row = await CashHandover.findOne({ _id: req.params.handoverId, ...req.scope }).session(session);
    if (!row) throw errors.notFound("Cash handover");
    if (row.status !== CashHandoverStatus.PENDING && action !== "resolve-discrepancy") throw new AppError("CASH_HANDOVER_ALREADY_SETTLED", "This handover is already settled.", 409);
    if (action === "resolve-discrepancy") {
      if (row.status !== CashHandoverStatus.DISCREPANCY) throw new AppError("CASH_HANDOVER_NOT_IN_DISCREPANCY", "Only a discrepancy handover can be resolved.", 409);
      row.status = req.body.accepted ? CashHandoverStatus.ACCEPTED : CashHandoverStatus.REJECTED;
      if (req.body.accepted && req.body.acceptedAmountPaise != null) {
        row.acceptedAmountPaise = req.body.acceptedAmountPaise;
        row.discrepancyPaise = row.amountPaise - req.body.acceptedAmountPaise;
      }
    } else if (action === "accept") {
      const acceptedAmountPaise = req.body.acceptedAmountPaise ?? row.amountPaise;
      if (acceptedAmountPaise !== row.amountPaise) {
        row.status = CashHandoverStatus.DISCREPANCY;
        row.acceptedAmountPaise = acceptedAmountPaise;
        row.discrepancyPaise = row.amountPaise - acceptedAmountPaise;
        row.discrepancyDirection = row.discrepancyPaise > 0 ? "SHORTFALL" : "OVERAGE";
      } else {
        row.status = CashHandoverStatus.ACCEPTED;
        row.acceptedAmountPaise = acceptedAmountPaise;
        row.discrepancyPaise = 0;
      }
    } else if (action === "reject") {
      row.status = CashHandoverStatus.REJECTED;
    } else {
      throw errors.validation([{ field: "action", message: "Unsupported handover action." }]);
    }
    row.settledAt = new Date();
    row.settledBy = req.auth.id;
    row.reason = req.body.reason;
    if (req.body.discrepancyPaise != null && row.status === CashHandoverStatus.DISCREPANCY) row.discrepancyPaise = req.body.discrepancyPaise;
    row.version += 1;
    await row.save({ session });
    const auditEventId = await writeAudit({ req, action: `CASH_HANDOVER_${row.status}`, entityType: AuditEntityType.CASH_HANDOVER, entityId: row._id, after: row.toObject(), session });
    return { ...row.toObject(), auditEventId };
  });
}
export async function cancelHandover(req) {
  return withTransaction(async (session) => {
    const row = await CashHandover.findOne({ _id: req.params.handoverId, tenantId: req.auth.tenantId, staffId: req.auth.id }).session(session);
    if (!row) throw errors.notFound("Cash handover");
    if (row.status !== CashHandoverStatus.PENDING) throw new AppError("CASH_HANDOVER_ALREADY_SETTLED", "This handover cannot be cancelled.", 409);
    row.status = CashHandoverStatus.CANCELLED;
    row.reason = "Cancelled by staff";
    row.version += 1;
    await row.save({ session });
    const auditEventId = await writeAudit({ req, action: "CASH_HANDOVER_CANCELLED", entityType: AuditEntityType.CASH_HANDOVER, entityId: row._id, after: row.toObject(), session });
    return { ...row.toObject(), auditEventId };
  });
}
export async function listHandovers(req, staffOnly = false) { const scope = { ...req.scope, ...(staffOnly ? { staffId: req.auth.id } : {}) }; const filters = req.query.status ? { status: req.query.status } : {}; return paginate(CashHandover, { scope, filters, cursor: req.query.cursor, limit: req.query.limit, sort: "createdAt:desc" }); }
export async function createCashAdjustment(req) { return withTransaction(async (session) => { const row = (await CashAdjustment.create([{ _id: createId("cashAdjustment"), tenantId: req.auth.tenantId, branchId: req.scope.branchId ?? req.body.branchId, staffId: req.body.staffId, direction: req.body.direction, amountPaise: req.body.amountPaise, reason: req.body.reason, createdBy: req.auth.id }], { session }))[0]; const auditEventId = await writeAudit({ req, action: "CASH_ADJUSTMENT_CREATED", entityType: AuditEntityType.CASH_HANDOVER, entityId: row._id, after: row.toObject(), session }); return { ...row.toObject(), auditEventId }; }); }
