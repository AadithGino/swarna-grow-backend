import { AuditEntityType, CashAdjustmentDirection, CashHandoverStatus, HandoverInitiator, PaymentMode, TenantRole, UserStatus, UserType } from "../constants/enums.js";
import { Branch, CashAdjustment, CashHandover, CashStaffCustody, Customer, Payment, User } from "../models/index.js";
import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { writeAudit } from "./audit.service.js";
import { paginate } from "../lib/pagination.js";
import { moneyRef } from "../lib/money.js";
import { now } from "../lib/date.js";
import { dateMatch, effectiveScope } from "../lib/query-filters.js";
import { cashPaymentBranchMatch } from "../lib/payment-scope.js";
import { branchDto, loadBranchMap, loadUserMap, userDto } from "../lib/relation-maps.js";
import {
  netCollectionStatusFilter,
  paymentFinancialHistoryStatusFilter,
  paymentNetFieldsFromDoc,
  sumNetAmountPaise,
} from "../lib/payment-net-aggregation.js";

async function sumAggregate(model, pipeline, session) {
  const query = model.aggregate(pipeline);
  if (session) query.session(session);
  const [row] = await query;
  return row?.amountPaise ?? 0;
}

export async function cashBalance({ tenantId, branchId, staffId, paidAtRange, handoverSettledRange, adjustmentRange }, session) {
  const paymentMatch = {
    tenantId,
    mode: PaymentMode.CASH,
    ...netCollectionStatusFilter(),
    collectedBy: staffId,
    ...cashPaymentBranchMatch(branchId, staffId),
  };
  if (paidAtRange) paymentMatch.paidAt = paidAtRange;
  const handoverBase = { tenantId, staffId, ...(branchId ? { branchId } : {}) };
  if (handoverSettledRange) handoverBase.settledAt = handoverSettledRange;
  const adjustmentMatch = { tenantId, staffId, ...(branchId ? { branchId } : {}) };
  if (adjustmentRange) adjustmentMatch.createdAt = adjustmentRange;
  const cashCollectedPaise = await sumAggregate(
    Payment,
    [{ $match: paymentMatch }, { $group: { _id: null, amountPaise: sumNetAmountPaise() } }],
    session,
  );
  const acceptedPaise = await sumAggregate(CashHandover, [{ $match: { ...handoverBase, status: CashHandoverStatus.ACCEPTED } }, { $group: { _id: null, amountPaise: { $sum: "$amountPaise" } } }], session);
  const discrepancyAcceptedPaise = await sumAggregate(CashHandover, [{ $match: { ...handoverBase, status: CashHandoverStatus.DISCREPANCY } }, { $group: { _id: null, amountPaise: { $sum: { $ifNull: ["$acceptedAmountPaise", { $subtract: ["$amountPaise", { $ifNull: ["$discrepancyPaise", 0] }] }] } } } }], session);
  const cashPendingAcceptancePaise = await sumAggregate(CashHandover, [{ $match: { ...handoverBase, status: CashHandoverStatus.PENDING } }, { $group: { _id: null, amountPaise: { $sum: "$amountPaise" } } }], session);
  const adjustmentPaise = await sumAggregate(CashAdjustment, [{ $match: adjustmentMatch }, { $group: { _id: null, amountPaise: { $sum: { $cond: [{ $eq: ["$direction", CashAdjustmentDirection.CREDIT] }, "$amountPaise", { $multiply: ["$amountPaise", -1] }] } } } }], session);
  const handedOverPaise = acceptedPaise + discrepancyAcceptedPaise;
  const cashInHandPaise = cashCollectedPaise + adjustmentPaise - handedOverPaise;
  const availableForHandoverPaise = Math.max(0, cashInHandPaise - cashPendingAcceptancePaise);
  return {
    cashCollectedPaise,
    cashInHandPaise,
    cashPendingAcceptancePaise,
    availableForHandoverPaise,
    collectedPaise: cashCollectedPaise,
    handedOverPaise,
    adjustmentPaise,
  };
}

const CASH_STAFF_ROLES = [TenantRole.BRANCH_STAFF, TenantRole.BRANCH_MANAGER, TenantRole.COLLECTION_AGENT];
const dayStart = () => now().startOf("day").toDate();

function cashScope(req) {
  const scope = effectiveScope(req);
  return { tenantId: scope.tenantId, branchId: scope.branchId ?? null };
}

async function listCashStaff(req) {
  const { tenantId, branchId } = cashScope(req);
  return User.find({
    tenantId, type: UserType.TENANT_USER, role: { $in: CASH_STAFF_ROLES }, status: UserStatus.ACTIVE,
    ...(branchId ? { branchId } : {}),
  }).select("_id name mobile role branchId status").sort({ name: 1 }).lean();
}

async function branchMap(tenantId, branchIds) {
  const ids = [...new Set(branchIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await Branch.find({ tenantId, _id: { $in: ids } }).select("_id name code").lean();
  return new Map(rows.map((row) => [row._id, row]));
}

async function staffCashExtras({ tenantId, branchId, staffId }) {
  const paymentMatch = {
    tenantId,
    mode: PaymentMode.CASH,
    ...netCollectionStatusFilter(),
    collectedBy: staffId,
    ...cashPaymentBranchMatch(branchId, staffId),
    paidAt: { $gte: dayStart() },
  };
  const handoverMatch = { tenantId, staffId, ...(branchId ? { branchId } : {}), status: { $in: [CashHandoverStatus.ACCEPTED, CashHandoverStatus.DISCREPANCY, CashHandoverStatus.REJECTED] } };
  const [collectedToday, lastHandover] = await Promise.all([
    sumAggregate(Payment, [{ $match: paymentMatch }, { $group: { _id: null, amountPaise: sumNetAmountPaise() } }]),
    CashHandover.findOne(handoverMatch).sort({ settledAt: -1, submittedAt: -1 }).select("settledAt submittedAt").lean(),
  ]);
  return { cashCollectedTodayPaise: collectedToday, lastHandoverAt: lastHandover?.settledAt ?? lastHandover?.submittedAt ?? null };
}

function riskFlag(cashInHandPaise, lastHandoverAt) {
  if (cashInHandPaise >= 5000000) return "HIGH_BALANCE";
  if (cashInHandPaise > 0 && lastHandoverAt) {
    const days = Math.floor((Date.now() - new Date(lastHandoverAt).getTime()) / 86_400_000);
    if (days > 2) return "HOLDING_TOO_LONG";
  } else if (cashInHandPaise > 0 && !lastHandoverAt) {
    return "HOLDING_TOO_LONG";
  }
  return null;
}

export async function adminCashOverview(req) {
  const { tenantId, branchId } = cashScope(req);
  const handoverScope = { tenantId, ...(branchId ? { branchId } : {}) };
  const [pending, acceptedAmountPaise, pendingAcceptancePaise, discrepancyTotalPaise, staff] = await Promise.all([
    CashHandover.countDocuments({ ...handoverScope, status: CashHandoverStatus.PENDING }),
    sumAggregate(CashHandover, [{ $match: { ...handoverScope, status: CashHandoverStatus.ACCEPTED } }, { $group: { _id: null, amountPaise: { $sum: "$amountPaise" } } }]),
    sumAggregate(CashHandover, [{ $match: { ...handoverScope, status: CashHandoverStatus.PENDING } }, { $group: { _id: null, amountPaise: { $sum: "$amountPaise" } } }]),
    sumAggregate(CashHandover, [{ $match: { ...handoverScope, status: CashHandoverStatus.DISCREPANCY } }, { $group: { _id: null, amountPaise: { $sum: { $ifNull: ["$discrepancyPaise", 0] } } } }]),
    listCashStaff(req),
  ]);
  const balances = await Promise.all(staff.map(async (row) => {
    const balance = await cashBalance({ tenantId, branchId: branchId ?? row.branchId, staffId: row._id });
    return { staff: row, balance };
  }));
  const totalCashInHandPaise = balances.reduce((sum, row) => sum + row.balance.cashInHandPaise, 0);
  const holding = balances
    .filter((row) => row.balance.cashInHandPaise > 0)
    .sort((a, b) => b.balance.cashInHandPaise - a.balance.cashInHandPaise)
    .slice(0, 12);
  return {
    pending,
    acceptedAmountPaise,
    totals: {
      totalCashInHand: moneyRef(totalCashInHandPaise),
      pendingAcceptance: moneyRef(pendingAcceptancePaise),
      pendingHandoverCount: pending,
      discrepancyTotal: moneyRef(discrepancyTotalPaise),
      staffHoldingCash: holding.length,
    },
    chart: {
      chartType: "horizontalBar",
      title: "Cash in hand by staff",
      yAxis: { type: "currency", label: "Amount" },
      series: [{
        key: "CASH_IN_HAND",
        name: "Cash in hand",
        data: holding.map((row) => ({ x: row.staff.name, y: row.balance.cashInHandPaise, yDisplay: moneyRef(row.balance.cashInHandPaise).amountDisplay })),
      }],
    },
  };
}

export async function adminStaffBalances(req) {
  const { tenantId, branchId } = cashScope(req);
  const staff = await listCashStaff(req);
  const branches = await branchMap(tenantId, staff.map((row) => row.branchId));
  let items = await Promise.all(staff.map(async (row) => {
    const scopeBranch = branchId ?? row.branchId;
    const [balance, extras] = await Promise.all([
      cashBalance({ tenantId, branchId: scopeBranch, staffId: row._id }),
      staffCashExtras({ tenantId, branchId: scopeBranch, staffId: row._id }),
    ]);
    const branch = branches.get(row.branchId);
    const flag = riskFlag(balance.cashInHandPaise, extras.lastHandoverAt);
    return {
      staff: { _id: row._id, id: row._id, name: row.name, mobile: row.mobile, role: row.role },
      branchId: row.branchId,
      branch: branch ? { id: branch._id, _id: branch._id, name: branch.name, code: branch.code } : null,
      cashInHand: moneyRef(balance.cashInHandPaise),
      cashPendingAcceptance: moneyRef(balance.cashPendingAcceptancePaise),
      availableForHandover: moneyRef(balance.availableForHandoverPaise),
      cashCollectedToday: moneyRef(extras.cashCollectedTodayPaise),
      lastHandoverAt: extras.lastHandoverAt,
      status: row.status,
      riskFlag: flag,
      actions: {
        canMarkSubmitted: balance.availableForHandoverPaise > 0,
        canViewCollections: true,
      },
    };
  }));
  if (req.query.hasBalance === "true") items = items.filter((row) => row.cashInHand.amountPaise > 0);
  if ((req.query.sort ?? "").startsWith("cashInHand")) {
    const desc = (req.query.sort ?? "").endsWith("desc");
    items.sort((a, b) => desc ? b.cashInHand.amountPaise - a.cashInHand.amountPaise : a.cashInHand.amountPaise - b.cashInHand.amountPaise);
  }
  const totalCashInHandPaise = items.reduce((sum, row) => sum + row.cashInHand.amountPaise, 0);
  return { data: items, meta: { nextCursor: null, hasMore: false, limit: items.length, summary: { staffCount: items.length, totalCashInHand: moneyRef(totalCashInHandPaise) } } };
}

export async function adminStaffBalanceDetail(req) {
  const { tenantId, branchId } = cashScope(req);
  const staff = await User.findOne({
    _id: req.params.staffId, tenantId, type: UserType.TENANT_USER, role: { $in: CASH_STAFF_ROLES },
  }).select("_id name mobile role branchId status").lean();
  if (!staff) throw errors.notFound("Staff");
  const scopeBranch = branchId ?? staff.branchId;
  const [balance, extras, paymentRows, branch] = await Promise.all([
    cashBalance({ tenantId, branchId: scopeBranch, staffId: staff._id }),
    staffCashExtras({ tenantId, branchId: scopeBranch, staffId: staff._id }),
    Payment.find({
      tenantId,
      collectedBy: staff._id,
      mode: PaymentMode.CASH,
      ...paymentFinancialHistoryStatusFilter(),
      ...(scopeBranch ? { branchId: scopeBranch } : {}),
    }).sort({ paidAt: -1 }).limit(100).lean(),
    staff.branchId ? Branch.findOne({ _id: staff.branchId, tenantId }).select("_id name code").lean() : null,
  ]);
  const customerIds = [...new Set(paymentRows.map((row) => row.customerId).filter(Boolean))];
  const customers = customerIds.length
    ? await Customer.find({ tenantId, _id: { $in: customerIds } }).select("_id name").lean()
    : [];
  const customerMap = new Map(customers.map((row) => [row._id, row.name]));
  let collectionsNetTotalPaise = 0;
  const collections = paymentRows.map((row) => {
    const netFields = paymentNetFieldsFromDoc(row);
    if (netFields.netAmountPaise > 0) {
      collectionsNetTotalPaise += netFields.netAmountPaise;
    }
    return {
      ...row,
      grossAmount: moneyRef(netFields.grossAmountPaise),
      refundedAmount: moneyRef(netFields.refundedAmountPaise),
      netAmount: moneyRef(netFields.netAmountPaise),
      customer: row.customerId
        ? { id: row.customerId, name: customerMap.get(row.customerId) ?? row.customerId }
        : undefined,
    };
  });
  return {
    staff: { _id: staff._id, id: staff._id, name: staff.name, mobile: staff.mobile, role: staff.role },
    branchId: staff.branchId,
    branch: branch ? { id: branch._id, _id: branch._id, name: branch.name, code: branch.code } : null,
    ...balance,
    cashInHand: moneyRef(balance.cashInHandPaise),
    cashPendingAcceptance: moneyRef(balance.cashPendingAcceptancePaise),
    availableForHandover: moneyRef(balance.availableForHandoverPaise),
    cashCollectedToday: moneyRef(extras.cashCollectedTodayPaise),
    lastHandoverAt: extras.lastHandoverAt,
    status: staff.status,
    riskFlag: riskFlag(balance.cashInHandPaise, extras.lastHandoverAt),
    collections,
    collectionsNetTotal: moneyRef(collectionsNetTotalPaise),
    receiptCount: paymentRows.length,
  };
}

function reportDateRanges(query) {
  const paidAtRange = dateMatch("paidAt", query).paidAt;
  const handoverSettledRange = dateMatch("settledAt", query).settledAt;
  const adjustmentRange = dateMatch("createdAt", query).createdAt;
  return { paidAtRange, handoverSettledRange, adjustmentRange };
}

export async function adminCashReport(req) {
  const { tenantId, branchId } = cashScope(req);
  const staff = await listCashStaff(req);
  const dateFilter = dateMatch("settledAt", req.query);
  const ranges = reportDateRanges(req.query);
  const groups = await Promise.all(staff.map(async (row) => {
    const scopeBranch = branchId ?? row.branchId;
    const handoverMatch = { tenantId, staffId: row._id, ...(scopeBranch ? { branchId: scopeBranch } : {}), ...dateFilter };
    const [balance, handoverCount, discrepancies] = await Promise.all([
      cashBalance({
        tenantId,
        branchId: scopeBranch,
        staffId: row._id,
        paidAtRange: ranges.paidAtRange,
        handoverSettledRange: ranges.handoverSettledRange,
        adjustmentRange: ranges.adjustmentRange,
      }),
      CashHandover.countDocuments({ ...handoverMatch, status: { $in: [CashHandoverStatus.ACCEPTED, CashHandoverStatus.DISCREPANCY] } }),
      CashHandover.countDocuments({ ...handoverMatch, status: CashHandoverStatus.DISCREPANCY }),
    ]);
    return {
      key: row._id,
      label: row.name,
      cashCollected: moneyRef(balance.cashCollectedPaise),
      handedOver: moneyRef(balance.handedOverPaise),
      inHand: moneyRef(balance.cashInHandPaise),
      handoverCount,
      discrepancies,
    };
  }));
  const handoverScope = { tenantId, ...(branchId ? { branchId } : {}), ...dateFilter };
  const [discrepancyTotalPaise, handoverCount] = await Promise.all([
    sumAggregate(CashHandover, [{ $match: { ...handoverScope, status: CashHandoverStatus.DISCREPANCY } }, { $group: { _id: null, amountPaise: { $sum: { $ifNull: ["$discrepancyPaise", 0] } } } }]),
    CashHandover.countDocuments({ ...handoverScope, status: { $in: [CashHandoverStatus.ACCEPTED, CashHandoverStatus.DISCREPANCY] } }),
  ]);
  const totals = {
    cashCollected: moneyRef(groups.reduce((sum, row) => sum + row.cashCollected.amountPaise, 0)),
    handedOver: moneyRef(groups.reduce((sum, row) => sum + row.handedOver.amountPaise, 0)),
    currentlyInHand: moneyRef(groups.reduce((sum, row) => sum + row.inHand.amountPaise, 0)),
    discrepancyTotal: moneyRef(discrepancyTotalPaise),
    handoverCount,
  };
  return { totals, groups, groupBy: req.query.groupBy ?? "STAFF" };
}

async function assertCashStaffForCustody(req, { staffId, branchId, session }) {
  const tenantId = req.auth.tenantId;
  const staff = await User.findOne({
    _id: staffId,
    tenantId,
    type: UserType.TENANT_USER,
  })
    .select("branchId role status")
    .session(session)
    .lean();
  if (!staff) throw errors.notFound("Staff");
  if (staff.status !== UserStatus.ACTIVE) {
    throw errors.business("STAFF_NOT_ACTIVE", "This staff member is not active.");
  }
  if (!CASH_STAFF_ROLES.includes(staff.role)) {
    throw errors.business("STAFF_NOT_CASH_HANDLER", "This user is not allowed to hold cash custody.");
  }
  const effectiveBranch = branchId ?? req.scope.branchId ?? req.body.branchId ?? staff.branchId ?? null;
  if (effectiveBranch && staff.branchId && staff.branchId !== effectiveBranch) {
    throw errors.notFound("Staff");
  }
  return { branchId: effectiveBranch ?? staff.branchId ?? null };
}

async function resolveHandoverContext(req, initiator, session) {
  const tenantId = req.auth.tenantId;
  const staffId = initiator === HandoverInitiator.STAFF ? req.auth.id : req.body.staffId;
  if (!staffId) {
    throw errors.validation([{ field: "staffId", message: "Staff is required for this handover." }]);
  }
  const branchId = req.scope.branchId ?? req.body.branchId ?? null;
  const { branchId: resolvedBranch } = await assertCashStaffForCustody(req, {
    staffId,
    branchId,
    session,
  });
  return { tenantId, staffId, branchId: resolvedBranch };
}

async function lockCashStaffCustody(session, { tenantId, branchId, staffId }) {
  await CashStaffCustody.findOneAndUpdate(
    { tenantId, branchId, staffId },
    {
      $inc: { version: 1 },
      $setOnInsert: { _id: createId("csc"), tenantId, branchId, staffId },
    },
    { upsert: true, session },
  );
}

export async function createHandover(req, initiator) {
  return withTransaction(async (session) => {
    const { tenantId, staffId, branchId } = await resolveHandoverContext(req, initiator, session);
    await lockCashStaffCustody(session, { tenantId, branchId, staffId });
    const balance = await cashBalance({ tenantId, branchId, staffId }, session);
    if (req.body.amountPaise > balance.availableForHandoverPaise) {
      throw errors.business(
        "CASH_HANDOVER_AMOUNT_EXCEEDS_BALANCE",
        "The handover exceeds the amount available to submit after pending handovers.",
        balance,
      );
    }
    const row = (await CashHandover.create([{
      _id: createId("handover"),
      tenantId,
      branchId,
      staffId,
      amountPaise: req.body.amountPaise,
      remarks: req.body.remarks,
      initiator,
      submittedAt: new Date(),
    }], { session }))[0];
    const afterBalance = await cashBalance({ tenantId, branchId, staffId }, session);
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
    if (row.status === CashHandoverStatus.ACCEPTED) {
      const acceptedAmountPaise = row.acceptedAmountPaise ?? row.amountPaise;
      const diffPaise = row.amountPaise - acceptedAmountPaise;
      if (diffPaise !== 0) {
        await CashAdjustment.create([{
          _id: createId("cad"),
          tenantId: row.tenantId,
          branchId: row.branchId,
          staffId: row.staffId,
          // Accepted amount differs from declared: shortfall restores custody;
          // overage removes extra cash counted as handed over.
          direction: diffPaise > 0 ? CashAdjustmentDirection.CREDIT : CashAdjustmentDirection.DEBIT,
          amountPaise: Math.abs(diffPaise),
          reason: diffPaise > 0 ? "Cash handover shortfall" : "Cash handover overage",
          createdBy: req.auth.id,
        }], { session });
      }
    }
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
export async function listHandovers(req, staffOnly = false) {
  const scope = { ...req.scope, ...(staffOnly ? { staffId: req.auth.id } : {}) };
  const filters = {};
  if (req.query.status) filters.status = req.query.status;
  if (req.query.staffId && !staffOnly) filters.staffId = req.query.staffId;
  Object.assign(filters, dateMatch("createdAt", req.query));
  return paginate(CashHandover, { scope, filters, cursor: req.query.cursor, limit: req.query.limit, sort: "createdAt:desc" });
}

export async function getHandoverForStaff(req) {
  const row = await CashHandover.findOne({
    _id: req.params.handoverId,
    tenantId: req.auth.tenantId,
    staffId: req.auth.id,
  }).lean();
  if (!row) throw errors.notFound("Cash handover");

  const relatedUserIds = [row.settledBy, row.staffId].filter(Boolean);
  const [branchMap, userMap] = await Promise.all([
    loadBranchMap(req.auth.tenantId, [row.branchId]),
    loadUserMap(relatedUserIds),
  ]);
  const branch = branchMap.get(row.branchId);
  const settledByUser = userMap.get(row.settledBy);
  const staffUser = userMap.get(row.staffId);
  const staffName = staffUser?.name ?? "You";

  const timeline = [];
  const submittedAt = row.submittedAt ?? row.createdAt;
  if (submittedAt) {
    timeline.push({
      event: "SUBMITTED",
      at: submittedAt,
      by: staffName,
      note: row.remarks ?? undefined,
    });
  }
  if (row.status === CashHandoverStatus.PENDING) {
    timeline.push({
      event: "AWAITING_ACCEPTANCE",
      at: submittedAt ?? new Date(),
      by: branch?.name ?? "Branch",
    });
  } else if (row.settledAt) {
    const by = settledByUser?.name ?? "Branch";
    if (row.status === CashHandoverStatus.CANCELLED) {
      timeline.push({ event: "CANCELLED", at: row.settledAt, by: staffName, note: row.reason ?? undefined });
    } else if (row.status === CashHandoverStatus.REJECTED) {
      timeline.push({ event: "REJECTED", at: row.settledAt, by, note: row.reason ?? undefined });
    } else if (row.status === CashHandoverStatus.DISCREPANCY) {
      timeline.push({
        event: "ACCEPTED_WITH_DISCREPANCY",
        at: row.settledAt,
        by,
        note:
          row.discrepancyPaise != null
            ? `Difference ${moneyRef(row.discrepancyPaise).amountDisplay}`
            : row.reason ?? undefined,
      });
    } else if (row.status === CashHandoverStatus.ACCEPTED) {
      timeline.push({
        event: "ACCEPTED",
        at: row.settledAt,
        by,
        note: row.acceptedAmountPaise != null && row.acceptedAmountPaise !== row.amountPaise ? `Accepted ${row.acceptedAmountPaise} paise` : undefined,
      });
    }
  }

  return {
    ...row,
    id: row._id,
    branch: branchDto(branch),
    settledBy: userDto(settledByUser),
    timeline,
  };
}
export async function createCashAdjustment(req) {
  return withTransaction(async (session) => {
    const branchId = req.scope.branchId ?? req.body.branchId ?? null;
    const { branchId: resolvedBranch } = await assertCashStaffForCustody(req, {
      staffId: req.body.staffId,
      branchId,
      session,
    });
    await lockCashStaffCustody(session, {
      tenantId: req.auth.tenantId,
      branchId: resolvedBranch,
      staffId: req.body.staffId,
    });
    const row = (await CashAdjustment.create([{
      _id: createId("cashAdjustment"),
      tenantId: req.auth.tenantId,
      branchId: resolvedBranch,
      staffId: req.body.staffId,
      direction: req.body.direction,
      amountPaise: req.body.amountPaise,
      reason: req.body.reason,
      createdBy: req.auth.id,
    }], { session }))[0];
    const auditEventId = await writeAudit({
      req,
      action: "CASH_ADJUSTMENT_CREATED",
      entityType: AuditEntityType.CASH_HANDOVER,
      entityId: row._id,
      after: row.toObject(),
      session,
    });
    return { ...row.toObject(), auditEventId };
  });
}
