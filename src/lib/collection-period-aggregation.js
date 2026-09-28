import { Payment } from "../models/index.js";
import { PAYMENT_MODE_LABELS, PAYMENT_MODE_ORDER } from "../constants/enums.js";
import { dateMatch } from "./query-filters.js";
import { paymentFinancialHistoryStatusFilter } from "./payment-net-aggregation.js";

export function refundEventAtBounds(range) {
  const from = range.from ? new Date(`${range.from}T00:00:00+05:30`) : null;
  const to = range.to ? new Date(`${range.to}T23:59:59.999+05:30`) : null;
  if (!from && !to) return null;
  const bounds = {};
  if (from) bounds.$gte = from;
  if (to) bounds.$lte = to;
  return bounds;
}

export function refundEventAtAddFields() {
  return {
    refundEventAt: {
      $ifNull: ["$lastRefundedAt", { $ifNull: ["$reversedAt", "$paidAt"] }],
    },
  };
}

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

function buildRefundPipeline(baseMatch, refundEventBounds) {
  return [
    {
      $match: {
        ...baseMatch,
        refundedAmountPaise: { $gt: 0 },
      },
    },
    { $addFields: refundEventAtAddFields() },
    ...(refundEventBounds ? [{ $match: { refundEventAt: refundEventBounds } }] : []),
  ];
}

/**
 * Gross collections by paidAt, refund outflow by refund event date, net = gross − refunds.
 */
export async function aggregateCollectionPeriod(baseMatch, range) {
  const grossMatch = {
    ...baseMatch,
    ...dateMatch("paidAt", range),
  };
  const refundEventBounds = refundEventAtBounds(range);
  const refundPipeline = buildRefundPipeline(baseMatch, refundEventBounds);

  const [grossTotals, grossModes, refundTotals, refundModes] = await Promise.all([
    Payment.aggregate([
      { $match: grossMatch },
      { $group: { _id: null, amountPaise: { $sum: "$amountPaise" }, count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      { $match: grossMatch },
      { $group: { _id: "$mode", amountPaise: { $sum: "$amountPaise" }, count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      ...refundPipeline,
      { $group: { _id: null, amountPaise: { $sum: "$refundedAmountPaise" }, count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      ...refundPipeline,
      {
        $group: {
          _id: "$mode",
          amountPaise: { $sum: "$refundedAmountPaise" },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const grossAmountPaise = grossTotals[0]?.amountPaise ?? 0;
  const refundOutflowPaise = refundTotals[0]?.amountPaise ?? 0;
  const netAmountPaise = grossAmountPaise - refundOutflowPaise;

  const netByModeMap = new Map();
  for (const row of grossModes) {
    netByModeMap.set(row._id, { amountPaise: row.amountPaise ?? 0, count: row.count ?? 0 });
  }
  for (const row of refundModes) {
    const current = netByModeMap.get(row._id) ?? { amountPaise: 0, count: 0 };
    netByModeMap.set(row._id, {
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

/** Daily gross (paidAt) and refund (refundEventAt) buckets for cash vs digital trend charts. */
export async function aggregateCollectionTrendBuckets(baseMatch, range) {
  const grossMatch = { ...baseMatch, ...dateMatch("paidAt", range) };
  const refundEventBounds = refundEventAtBounds(range);
  const refundPipeline = buildRefundPipeline(baseMatch, refundEventBounds);

  const dayBucket = {
    $dateToString: { format: "%Y-%m-%d", date: "$paidAt", timezone: "Asia/Kolkata" },
  };
  const refundDayBucket = {
    $dateToString: { format: "%Y-%m-%d", date: "$refundEventAt", timezone: "Asia/Kolkata" },
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
    Payment.aggregate([
      ...refundPipeline,
      {
        $group: {
          _id: { day: refundDayBucket, bucket: cashDigitalBucket },
          value: { $sum: "$refundedAmountPaise" },
        },
      },
    ]),
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
  const grossMatch = { ...baseMatch, ...dateMatch("paidAt", range) };
  const refundEventBounds = refundEventAtBounds(range);
  const refundPipeline = buildRefundPipeline(baseMatch, refundEventBounds);
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
    Payment.aggregate([
      ...refundPipeline,
      {
        $group: {
          _id: "$branchId",
          amountPaise: { $sum: "$refundedAmountPaise" },
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
