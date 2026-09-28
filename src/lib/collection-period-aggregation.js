import { Payment, PaymentRefund } from "../models/index.js";
import { GatewayRefundStatus, PAYMENT_MODE_LABELS, PAYMENT_MODE_ORDER } from "../constants/enums.js";
import { dateMatch } from "./query-filters.js";
import { paymentFinancialHistoryStatusFilter } from "./payment-net-aggregation.js";
import {
  aggregateGatewayRefundOutflowByMode,
  aggregateGatewayRefundTrendByDay,
  aggregateManualReversalOutflowByMode,
  aggregateTotalRefundOutflow,
  eventDateBounds,
} from "./collection-cash-outflow.js";

const fillModes = (rows) =>
  PAYMENT_MODE_ORDER.filter(
    (mode) => mode !== "LEGACY_ONLINE" || rows.some((row) => row._id === mode),
  ).map((mode) => {
    const row = rows.find((item) => item._id === mode);
    return {
      mode,
      label: PAYMENT_MODE_LABELS[mode],
      amountPaise: row?.amountPaise ?? 0,
      count: row?.count ?? 0,
    };
  });

/**
 * Gross collections by paidAt; refund outflow from completed gateway refunds and manual reversals by event date.
 */
export async function aggregateCollectionPeriod(baseMatch, range) {
  const scope = {
    tenantId: baseMatch.tenantId,
    ...(baseMatch.branchId ? { branchId: baseMatch.branchId } : {}),
    ...(baseMatch.collectedBy ? { collectedBy: baseMatch.collectedBy } : {}),
  };
  const grossMatch = {
    ...baseMatch,
    ...dateMatch("paidAt", range),
  };

  const [grossTotals, grossModes, refundTotals, gatewayByMode, manualByMode] = await Promise.all([
    Payment.aggregate([
      { $match: grossMatch },
      { $group: { _id: null, amountPaise: { $sum: "$amountPaise" }, count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      { $match: grossMatch },
      { $group: { _id: "$mode", amountPaise: { $sum: "$amountPaise" }, count: { $sum: 1 } } },
    ]),
    aggregateTotalRefundOutflow(scope, range),
    aggregateGatewayRefundOutflowByMode(scope, range),
    aggregateManualReversalOutflowByMode(scope, range),
  ]);

  const grossAmountPaise = grossTotals[0]?.amountPaise ?? 0;
  const refundOutflowPaise = refundTotals.amountPaise;
  const netAmountPaise = grossAmountPaise - refundOutflowPaise;

  const netByModeMap = new Map();
  for (const row of grossModes) {
    netByModeMap.set(row._id, { amountPaise: row.amountPaise ?? 0, count: row.count ?? 0 });
  }
  for (const [mode, row] of gatewayByMode.entries()) {
    const current = netByModeMap.get(mode) ?? { amountPaise: 0, count: 0 };
    netByModeMap.set(mode, {
      amountPaise: current.amountPaise - (row.amountPaise ?? 0),
      count: current.count,
    });
  }
  for (const [mode, row] of manualByMode.entries()) {
    const current = netByModeMap.get(mode) ?? { amountPaise: 0, count: 0 };
    netByModeMap.set(mode, {
      amountPaise: current.amountPaise - (row.amountPaise ?? 0),
      count: current.count,
    });
  }

  const byMode = fillModes(
    [...netByModeMap.entries()].map(([mode, stats]) => ({
      _id: mode,
      amountPaise: stats.amountPaise,
      count: stats.count,
    })),
  );

  return {
    amountPaise: netAmountPaise,
    grossAmountPaise,
    refundOutflowPaise,
    gatewayRefundOutflowPaise: refundTotals.gatewayOutflowPaise,
    manualCorrectionOutflowPaise: refundTotals.manualCorrectionPaise,
    count: grossTotals[0]?.count ?? 0,
    byMode,
  };
}

export function collectionPeriodBaseMatch(scope, extra = {}) {
  return {
    ...scope,
    ...paymentFinancialHistoryStatusFilter(),
    ...extra,
  };
}

export async function aggregateCollectionTrendBuckets(baseMatch, range) {
  const scope = {
    tenantId: baseMatch.tenantId,
    ...(baseMatch.branchId ? { branchId: baseMatch.branchId } : {}),
    ...(baseMatch.collectedBy ? { collectedBy: baseMatch.collectedBy } : {}),
  };
  const grossMatch = { ...baseMatch, ...dateMatch("paidAt", range) };
  const dayBucket = {
    $dateToString: { format: "%Y-%m-%d", date: "$paidAt", timezone: "Asia/Kolkata" },
  };
  const cashDigitalBucket = {
    $cond: [{ $eq: ["$mode", "CASH"] }, "CASH", "DIGITAL"],
  };

  const [grossRows, refundRows] = await Promise.all([
    Payment.aggregate([
      { $match: grossMatch },
      {
        $group: {
          _id: { day: dayBucket, bucket: cashDigitalBucket },
          value: { $sum: "$amountPaise" },
        },
      },
    ]),
    aggregateGatewayRefundTrendByDay(scope, range),
  ]);

  const byDay = new Map();
  for (const row of grossRows) {
    const day = row._id.day;
    const entry = byDay.get(day) ?? { CASH: 0, DIGITAL: 0 };
    entry[row._id.bucket] += row.value ?? 0;
    byDay.set(day, entry);
  }
  for (const row of refundRows) {
    const day = row._id.day;
    const entry = byDay.get(day) ?? { CASH: 0, DIGITAL: 0 };
    entry[row._id.bucket] -= row.value ?? 0;
    byDay.set(day, entry);
  }
  return byDay;
}

export async function aggregateCollectionByBranch(baseMatch, range) {
  const scope = {
    tenantId: baseMatch.tenantId,
    ...(baseMatch.branchId ? { branchId: baseMatch.branchId } : {}),
  };
  const grossMatch = { ...baseMatch, ...dateMatch("paidAt", range) };
  const completedAt = eventDateBounds(range);
  const [grossRows, refundRows] = await Promise.all([
    Payment.aggregate([
      { $match: grossMatch },
      {
        $group: {
          _id: "$branchId",
          amountPaise: { $sum: "$amountPaise" },
          count: { $sum: 1 },
        },
      },
    ]),
    PaymentRefund.aggregate([
      {
        $match: {
          tenantId: scope.tenantId,
          status: GatewayRefundStatus.COMPLETED,
          ...(completedAt ? { completedAt } : {}),
        },
      },
      {
        $lookup: {
          from: "payments",
          localField: "paymentId",
          foreignField: "_id",
          as: "payment",
        },
      },
      { $unwind: "$payment" },
      ...(scope.branchId ? [{ $match: { "payment.branchId": scope.branchId } }] : []),
      {
        $group: {
          _id: "$payment.branchId",
          amountPaise: { $sum: "$amountPaise" },
        },
      },
    ]),
  ]);

  const byBranch = new Map();
  for (const row of grossRows) {
    byBranch.set(row._id, { value: row.amountPaise ?? 0, count: row.count ?? 0 });
  }
  for (const row of refundRows) {
    const current = byBranch.get(row._id) ?? { value: 0, count: 0 };
    current.value -= row.amountPaise ?? 0;
    byBranch.set(row._id, current);
  }
  return [...byBranch.entries()].map(([branchId, stats]) => ({
    key: branchId,
    label: branchId,
    value: stats.value,
    count: stats.count,
  }));
}
