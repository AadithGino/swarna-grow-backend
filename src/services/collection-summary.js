import { Payment } from "../models/index.js";
import { PAYMENT_MODE_LABELS, PAYMENT_MODE_ORDER, TenantRole } from "../constants/enums.js";
import { dateMatch, resolveQueryDateRange } from "../lib/query-filters.js";
import { paymentListScope } from "../lib/payment-scope.js";
import { paymentFinancialHistoryStatusFilter } from "../lib/payment-net-aggregation.js";

const fillModes = (rows) =>
  PAYMENT_MODE_ORDER.filter((mode) => mode !== "LEGACY_ONLINE" || rows.some((row) => row._id === mode)).map((mode) => {
    const row = rows.find((item) => item._id === mode);
    return { mode, label: PAYMENT_MODE_LABELS[mode], amountPaise: row?.amountPaise ?? 0, count: row?.count ?? 0 };
  });

function refundEventAtBounds(range) {
  const from = range.from ? new Date(`${range.from}T00:00:00+05:30`) : null;
  const to = range.to ? new Date(`${range.to}T23:59:59.999+05:30`) : null;
  if (!from && !to) return null;
  const bounds = {};
  if (from) bounds.$gte = from;
  if (to) bounds.$lte = to;
  return bounds;
}

export async function collectionSummary(req) {
  const range = resolveQueryDateRange(req.query);
  const scope = await paymentListScope(req);
  const baseMatch = {
    ...scope,
    ...paymentFinancialHistoryStatusFilter(),
  };
  if (req.auth?.role === TenantRole.COLLECTION_AGENT) {
    baseMatch.collectedBy = req.auth.id;
  }

  const grossMatch = {
    ...baseMatch,
    ...dateMatch("paidAt", range),
  };

  const refundEventBounds = refundEventAtBounds(range);
  const refundPipeline = [
    {
      $match: {
        ...baseMatch,
        refundedAmountPaise: { $gt: 0 },
      },
    },
    {
      $addFields: {
        refundEventAt: {
          $ifNull: ["$lastRefundedAt", { $ifNull: ["$reversedAt", "$paidAt"] }],
        },
      },
    },
    ...(refundEventBounds ? [{ $match: { refundEventAt: refundEventBounds } }] : []),
  ];

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
