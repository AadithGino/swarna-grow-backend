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

function paymentJoinStages(scope) {
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
    {
      $match: {
        "payment.tenantId": scope.tenantId,
        ...(scope.branchId ? { "payment.branchId": scope.branchId } : {}),
        ...(scope.collectedBy ? { "payment.collectedBy": scope.collectedBy } : {}),
      },
    },
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

export async function aggregateManualReversalOutflow(scope, range) {
  const match = {
    tenantId: scope.tenantId,
    ...(scope.branchId ? { branchId: scope.branchId } : {}),
    ...(scope.collectedBy ? { collectedBy: scope.collectedBy } : {}),
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
    tenantId: scope.tenantId,
    ...(scope.branchId ? { branchId: scope.branchId } : {}),
    ...(scope.collectedBy ? { collectedBy: scope.collectedBy } : {}),
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
