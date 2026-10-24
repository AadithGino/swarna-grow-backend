import { Payment, PaymentRefund } from "../models/index.js";
import {
  GatewayRefundStatus,
  PaymentMode,
  PaymentStatus,
} from "../constants/enums.js";
import { dateMatch } from "./query-filters.js";

export function eventDateBounds(range) {
  const from = range.from ? new Date(`${range.from}T00:00:00+05:30`) : null;
  const to = range.to ? new Date(`${range.to}T23:59:59.999+05:30`) : null;
  if (!from && !to) return null;
  const bounds = {};
  if (from) bounds.$gte = from;
  if (to) bounds.$lte = to;
  return bounds;
}

/** Scope for refund joins and manual reversals; includes scheme filter from collection baseMatch. */
export function paymentScopeFromBaseMatch(baseMatch) {
  const scope = { tenantId: baseMatch.tenantId };
  if (baseMatch.branchId) scope.branchId = baseMatch.branchId;
  if (baseMatch.collectedBy) scope.collectedBy = baseMatch.collectedBy;
  if (baseMatch.schemeId) scope.schemeId = baseMatch.schemeId;
  return scope;
}

function joinedPaymentMatch(scope) {
  const match = { "payment.tenantId": scope.tenantId };
  if (scope.branchId) match["payment.branchId"] = scope.branchId;
  if (scope.collectedBy) match["payment.collectedBy"] = scope.collectedBy;
  if (scope.schemeId) match["payment.schemeId"] = scope.schemeId;
  return match;
}

export function directPaymentMatch(scope) {
  const match = { tenantId: scope.tenantId };
  if (scope.branchId) match.branchId = scope.branchId;
  if (scope.collectedBy) match.collectedBy = scope.collectedBy;
  if (scope.schemeId) match.schemeId = scope.schemeId;
  return match;
}

export function paymentJoinStages(scope) {
  return [
    {
      $lookup: {
        from: "payments",
        localField: "paymentId",
        foreignField: "_id",
        as: "payment",
      },
    },
    { $unwind: "$payment" },
    { $match: joinedPaymentMatch(scope) },
  ];
}

export async function aggregateGatewayRefundOutflow(scope, range) {
  const completedAt = eventDateBounds(range);
  const pipeline = [
    {
      $match: {
        tenantId: scope.tenantId,
        status: GatewayRefundStatus.COMPLETED,
        ...(completedAt ? { completedAt } : {}),
      },
    },
    ...paymentJoinStages(scope),
    {
      $group: {
        _id: null,
        amountPaise: { $sum: "$amountPaise" },
        count: { $sum: 1 },
      },
    },
  ];
  const rows = await PaymentRefund.aggregate(pipeline);
  return { amountPaise: rows[0]?.amountPaise ?? 0, count: rows[0]?.count ?? 0 };
}

export async function aggregateGatewayRefundOutflowByMode(scope, range) {
  const completedAt = eventDateBounds(range);
  const rows = await PaymentRefund.aggregate([
    {
      $match: {
        tenantId: scope.tenantId,
        status: GatewayRefundStatus.COMPLETED,
        ...(completedAt ? { completedAt } : {}),
      },
    },
    ...paymentJoinStages(scope),
    {
      $group: {
        _id: "$payment.mode",
        amountPaise: { $sum: "$amountPaise" },
        count: { $sum: 1 },
      },
    },
  ]);
  const map = new Map();
  for (const row of rows) map.set(row._id, row);
  return map;
}

export async function aggregateGatewayRefundOutflowByBranchMode(scope, range) {
  const completedAt = eventDateBounds(range);
  const rows = await PaymentRefund.aggregate([
    {
      $match: {
        tenantId: scope.tenantId,
        status: GatewayRefundStatus.COMPLETED,
        ...(completedAt ? { completedAt } : {}),
      },
    },
    ...paymentJoinStages(scope),
    {
      $group: {
        _id: { branchId: "$payment.branchId", mode: "$payment.mode" },
        amountPaise: { $sum: "$amountPaise" },
      },
    },
  ]);
  const map = new Map();
  for (const row of rows) {
    map.set(`${row._id.branchId}\0${row._id.mode}`, row.amountPaise ?? 0);
  }
  return map;
}

export async function aggregateManualReversalOutflow(scope, range) {
  const match = {
    ...directPaymentMatch(scope),
    status: PaymentStatus.REVERSED,
    reversedAt: { $exists: true, $ne: null },
    reversalReason: { $ne: "GATEWAY_REFUND_COMPLETED" },
    mode: { $nin: [PaymentMode.ONLINE_GATEWAY, PaymentMode.LEGACY_ONLINE] },
    ...dateMatch("reversedAt", range),
  };
  const rows = await Payment.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        amountPaise: { $sum: "$amountPaise" },
        count: { $sum: 1 },
      },
    },
  ]);
  return { amountPaise: rows[0]?.amountPaise ?? 0, count: rows[0]?.count ?? 0 };
}

export async function aggregateManualReversalOutflowByMode(scope, range) {
  const match = {
    ...directPaymentMatch(scope),
    status: PaymentStatus.REVERSED,
    reversedAt: { $exists: true, $ne: null },
    reversalReason: { $ne: "GATEWAY_REFUND_COMPLETED" },
    mode: { $nin: [PaymentMode.ONLINE_GATEWAY, PaymentMode.LEGACY_ONLINE] },
    ...dateMatch("reversedAt", range),
  };
  const rows = await Payment.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$mode",
        amountPaise: { $sum: "$amountPaise" },
        count: { $sum: 1 },
      },
    },
  ]);
  const map = new Map();
  for (const row of rows) map.set(row._id, row);
  return map;
}

export async function aggregateManualReversalOutflowByBranchMode(scope, range) {
  const match = {
    ...directPaymentMatch(scope),
    status: PaymentStatus.REVERSED,
    reversedAt: { $exists: true, $ne: null },
    reversalReason: { $ne: "GATEWAY_REFUND_COMPLETED" },
    mode: { $nin: [PaymentMode.ONLINE_GATEWAY, PaymentMode.LEGACY_ONLINE] },
    ...dateMatch("reversedAt", range),
  };
  const rows = await Payment.aggregate([
    { $match: match },
    {
      $group: {
        _id: { branchId: "$branchId", mode: "$mode" },
        amountPaise: { $sum: "$amountPaise" },
      },
    },
  ]);
  const map = new Map();
  for (const row of rows) {
    map.set(`${row._id.branchId}\0${row._id.mode}`, row.amountPaise ?? 0);
  }
  return map;
}

export async function aggregateTotalRefundOutflow(scope, range) {
  const [gateway, manual] = await Promise.all([
    aggregateGatewayRefundOutflow(scope, range),
    aggregateManualReversalOutflow(scope, range),
  ]);
  return {
    amountPaise: gateway.amountPaise + manual.amountPaise,
    gatewayOutflowPaise: gateway.amountPaise,
    manualCorrectionPaise: manual.amountPaise,
    count: gateway.count + manual.count,
  };
}

export async function aggregateGatewayRefundTrendByDay(scope, range) {
  const completedAt = eventDateBounds(range);
  return PaymentRefund.aggregate([
    {
      $match: {
        tenantId: scope.tenantId,
        status: GatewayRefundStatus.COMPLETED,
        ...(completedAt ? { completedAt } : {}),
      },
    },
    ...paymentJoinStages(scope),
    {
      $group: {
        _id: {
          day: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$completedAt",
              timezone: "Asia/Kolkata",
            },
          },
          bucket: {
            $cond: [{ $eq: ["$payment.mode", "CASH"] }, "CASH", "DIGITAL"],
          },
        },
        value: { $sum: "$amountPaise" },
      },
    },
  ]);
}

export async function aggregateManualReversalTrendByDay(scope, range) {
  const match = {
    ...directPaymentMatch(scope),
    status: PaymentStatus.REVERSED,
    reversedAt: { $exists: true, $ne: null },
    reversalReason: { $ne: "GATEWAY_REFUND_COMPLETED" },
    mode: { $nin: [PaymentMode.ONLINE_GATEWAY, PaymentMode.LEGACY_ONLINE] },
    ...dateMatch("reversedAt", range),
  };
  return Payment.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          day: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$reversedAt",
              timezone: "Asia/Kolkata",
            },
          },
          bucket: {
            $cond: [{ $eq: ["$mode", "CASH"] }, "CASH", "DIGITAL"],
          },
        },
        value: { $sum: "$amountPaise" },
      },
    },
  ]);
}

export async function aggregateGatewayRefundOutflowByBranch(scope, range) {
  const completedAt = eventDateBounds(range);
  const rows = await PaymentRefund.aggregate([
    {
      $match: {
        tenantId: scope.tenantId,
        status: GatewayRefundStatus.COMPLETED,
        ...(completedAt ? { completedAt } : {}),
      },
    },
    ...paymentJoinStages(scope),
    {
      $group: {
        _id: "$payment.branchId",
        amountPaise: { $sum: "$amountPaise" },
      },
    },
  ]);
  const map = new Map();
  for (const row of rows) map.set(row._id, row.amountPaise ?? 0);
  return map;
}

export async function aggregateManualReversalOutflowByBranch(scope, range) {
  const match = {
    ...directPaymentMatch(scope),
    status: PaymentStatus.REVERSED,
    reversedAt: { $exists: true, $ne: null },
    reversalReason: { $ne: "GATEWAY_REFUND_COMPLETED" },
    mode: { $nin: [PaymentMode.ONLINE_GATEWAY, PaymentMode.LEGACY_ONLINE] },
    ...dateMatch("reversedAt", range),
  };
  const rows = await Payment.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$branchId",
        amountPaise: { $sum: "$amountPaise" },
      },
    },
  ]);
  const map = new Map();
  for (const row of rows) map.set(row._id, row.amountPaise ?? 0);
  return map;
}

export async function aggregateCollectionDailyGross(baseMatch, range) {
  const grossMatch = { ...baseMatch, ...dateMatch("paidAt", range) };
  return Payment.aggregate([
    { $match: grossMatch },
    {
      $group: {
        _id: {
          $dateToString: { format: "%Y-%m-%d", date: "$paidAt", timezone: "Asia/Kolkata" },
        },
        grossPaise: { $sum: "$amountPaise" },
      },
    },
    { $sort: { _id: 1 } },
  ]);
}

export async function aggregateCollectionDailyNet(baseMatch, range) {
  const scope = paymentScopeFromBaseMatch(baseMatch);
  const [grossRows, gatewayRows, manualRows] = await Promise.all([
    aggregateCollectionDailyGross(baseMatch, range),
    aggregateGatewayRefundTrendByDay(scope, range),
    aggregateManualReversalTrendByDay(scope, range),
  ]);
  const byDay = new Map();
  for (const row of grossRows) {
    byDay.set(row._id, { grossPaise: row.grossPaise ?? 0, netPaise: row.grossPaise ?? 0 });
  }
  for (const row of gatewayRows) {
    const day = row._id.day;
    const entry = byDay.get(day) ?? { grossPaise: 0, netPaise: 0 };
    entry.netPaise -= row.value ?? 0;
    byDay.set(day, entry);
  }
  for (const row of manualRows) {
    const day = row._id.day;
    const entry = byDay.get(day) ?? { grossPaise: 0, netPaise: 0 };
    entry.netPaise -= row.value ?? 0;
    byDay.set(day, entry);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, stats]) => ({ _id: day, amountPaise: stats.netPaise, grossPaise: stats.grossPaise }));
}
