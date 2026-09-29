import { Payment } from "../models/index.js";
import { PAYMENT_MODE_LABELS, PAYMENT_MODE_ORDER } from "../constants/enums.js";
import { dateMatch } from "./query-filters.js";
import { paymentFinancialHistoryStatusFilter } from "./payment-net-aggregation.js";
import {
  aggregateGatewayRefundOutflowByBranch,
  aggregateGatewayRefundOutflowByBranchMode,
  aggregateGatewayRefundOutflowByMode,
  aggregateGatewayRefundTrendByDay,
  aggregateManualReversalOutflowByBranch,
  aggregateManualReversalOutflowByBranchMode,
  aggregateManualReversalOutflowByMode,
  aggregateManualReversalTrendByDay,
  aggregateTotalRefundOutflow,
  paymentScopeFromBaseMatch,
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
  const scope = paymentScopeFromBaseMatch(baseMatch);
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
  const scope = paymentScopeFromBaseMatch(baseMatch);
  const grossMatch = { ...baseMatch, ...dateMatch("paidAt", range) };
  const dayBucket = {
    $dateToString: { format: "%Y-%m-%d", date: "$paidAt", timezone: "Asia/Kolkata" },
  };
  const cashDigitalBucket = {
    $cond: [{ $eq: ["$mode", "CASH"] }, "CASH", "DIGITAL"],
  };

  const [grossRows, gatewayRows, manualRows] = await Promise.all([
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
    aggregateManualReversalTrendByDay(scope, range),
  ]);

  const byDay = new Map();
  for (const row of grossRows) {
    const day = row._id.day;
    const entry = byDay.get(day) ?? { CASH: 0, DIGITAL: 0 };
    entry[row._id.bucket] += row.value ?? 0;
    byDay.set(day, entry);
  }
  for (const row of gatewayRows) {
    const day = row._id.day;
    const entry = byDay.get(day) ?? { CASH: 0, DIGITAL: 0 };
    entry[row._id.bucket] -= row.value ?? 0;
    byDay.set(day, entry);
  }
  for (const row of manualRows) {
    const day = row._id.day;
    const entry = byDay.get(day) ?? { CASH: 0, DIGITAL: 0 };
    entry[row._id.bucket] -= row.value ?? 0;
    byDay.set(day, entry);
  }
  return byDay;
}

export async function aggregateCollectionByBranch(baseMatch, range) {
  const scope = paymentScopeFromBaseMatch(baseMatch);
  const grossMatch = { ...baseMatch, ...dateMatch("paidAt", range) };
  const [grossRows, gatewayByBranch, manualByBranch] = await Promise.all([
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
    aggregateGatewayRefundOutflowByBranch(scope, range),
    aggregateManualReversalOutflowByBranch(scope, range),
  ]);

  const byBranch = new Map();
  for (const row of grossRows) {
    byBranch.set(row._id, { value: row.amountPaise ?? 0, count: row.count ?? 0 });
  }
  for (const [branchId, outflow] of gatewayByBranch.entries()) {
    const current = byBranch.get(branchId) ?? { value: 0, count: 0 };
    current.value -= outflow;
    byBranch.set(branchId, current);
  }
  for (const [branchId, outflow] of manualByBranch.entries()) {
    const current = byBranch.get(branchId) ?? { value: 0, count: 0 };
    current.value -= outflow;
    byBranch.set(branchId, current);
  }
  return [...byBranch.entries()].map(([branchId, stats]) => ({
    key: branchId,
    label: branchId,
    value: stats.value,
    count: stats.count,
  }));
}

/**
 * Net collection by branch and mode for detailed collection report (event-dated gross and outflows).
 */
export async function aggregateCollectionBranchModeNet(baseMatch, range) {
  const scope = paymentScopeFromBaseMatch(baseMatch);
  const grossMatch = { ...baseMatch, ...dateMatch("paidAt", range) };
  const [grossRows, gatewayByBranchMode, manualByBranchMode] = await Promise.all([
    Payment.aggregate([
      { $match: grossMatch },
      {
        $group: {
          _id: { branchId: "$branchId", mode: "$mode" },
          grossPaise: { $sum: "$amountPaise" },
          count: { $sum: 1 },
          weightMg: { $sum: { $ifNull: ["$weightMg", 0] } },
        },
      },
    ]),
    aggregateGatewayRefundOutflowByBranchMode(scope, range),
    aggregateManualReversalOutflowByBranchMode(scope, range),
  ]);

  const map = new Map();
  const touch = (branchId, mode, patch) => {
    const key = `${branchId ?? "unknown"}\0${mode ?? "UNKNOWN"}`;
    const row = map.get(key) ?? {
      branchId: branchId ?? "unknown",
      mode: mode ?? "UNKNOWN",
      grossPaise: 0,
      gatewayOutflowPaise: 0,
      manualOutflowPaise: 0,
      count: 0,
      weightMg: 0,
    };
    Object.assign(row, patch);
    map.set(key, row);
  };

  for (const row of grossRows) {
    touch(row._id.branchId, row._id.mode, {
      grossPaise: row.grossPaise ?? 0,
      count: row.count ?? 0,
      weightMg: row.weightMg ?? 0,
    });
  }
  for (const [key, outflow] of gatewayByBranchMode.entries()) {
    const [branchId, mode] = key.split("\0");
    touch(branchId, mode, {});
    map.get(`${branchId ?? "unknown"}\0${mode ?? "UNKNOWN"}`).gatewayOutflowPaise += outflow;
  }
  for (const [key, outflow] of manualByBranchMode.entries()) {
    const [branchId, mode] = key.split("\0");
    touch(branchId, mode, {});
    map.get(`${branchId ?? "unknown"}\0${mode ?? "UNKNOWN"}`).manualOutflowPaise += outflow;
  }

  return [...map.values()].map((row) => ({
    ...row,
    netPaise: row.grossPaise - row.gatewayOutflowPaise - row.manualOutflowPaise,
  }));
}
