import { Payment, PaymentRefund } from "../models/index.js";
import { dateMatch } from "./query-filters.js";
import { iteratePeriodBuckets } from "./analytics-period.js";
import { GatewayRefundStatus, PaymentStatus } from "../constants/enums.js";
import {
  aggregateGatewayRefundTrendByDay,
  aggregateManualReversalTrendByDay,
  directPaymentMatch,
  eventDateBounds,
  paymentJoinStages,
  paymentScopeFromBaseMatch,
} from "./collection-cash-outflow.js";

function emptyDayRow() {
  return {
    paymentCount: 0,
    grossReceiptsPaise: 0,
    gatewayRefundOutflowPaise: 0,
    manualCorrectionOutflowPaise: 0,
    netCollectedPaise: 0,
  };
}

/**
 * Daily collection accounting rows (IST), zero-filled for every calendar day in range.
 */
export async function aggregateCollectionDailyAccounting(baseMatch, range) {
  const { from, to } = range ?? {};
  if (!from || !to) return [];

  const scope = paymentScopeFromBaseMatch(baseMatch);
  const grossMatch = { ...baseMatch, ...dateMatch("paidAt", range) };
  const dayBucket = {
    $dateToString: { format: "%Y-%m-%d", date: "$paidAt", timezone: "Asia/Kolkata" },
  };

  const [grossRows, gatewayRows, manualRows] = await Promise.all([
    Payment.aggregate([
      { $match: grossMatch },
      {
        $group: {
          _id: dayBucket,
          grossReceiptsPaise: { $sum: "$amountPaise" },
          paymentCount: { $sum: 1 },
        },
      },
    ]),
    aggregateGatewayRefundTrendByDay(scope, range),
    aggregateManualReversalTrendByDay(scope, range),
  ]);

  const byDay = new Map();
  for (const row of grossRows) {
    byDay.set(row._id, {
      paymentCount: row.paymentCount ?? 0,
      grossReceiptsPaise: row.grossReceiptsPaise ?? 0,
      gatewayRefundOutflowPaise: 0,
      manualCorrectionOutflowPaise: 0,
    });
  }
  for (const row of gatewayRows) {
    const day = row._id.day;
    const entry = byDay.get(day) ?? { ...emptyDayRow(), paymentCount: 0, grossReceiptsPaise: 0 };
    entry.gatewayRefundOutflowPaise += row.value ?? 0;
    byDay.set(day, entry);
  }
  for (const row of manualRows) {
    const day = row._id.day;
    const entry = byDay.get(day) ?? { ...emptyDayRow(), paymentCount: 0, grossReceiptsPaise: 0 };
    entry.manualCorrectionOutflowPaise += row.value ?? 0;
    byDay.set(day, entry);
  }

  return [...iteratePeriodBuckets(from, to, "DAY")].map((date) => {
    const stats = byDay.get(date) ?? emptyDayRow();
    const netCollectedPaise =
      stats.grossReceiptsPaise -
      stats.gatewayRefundOutflowPaise -
      stats.manualCorrectionOutflowPaise;
    return {
      date,
      paymentCount: stats.paymentCount ?? 0,
      grossReceiptsPaise: stats.grossReceiptsPaise ?? 0,
      gatewayRefundOutflowPaise: stats.gatewayRefundOutflowPaise ?? 0,
      manualCorrectionOutflowPaise: stats.manualCorrectionOutflowPaise ?? 0,
      netCollectedPaise,
    };
  });
}

function dayModeKey(day, mode) {
  return `${day}\0${mode}`;
}

async function aggregateGatewayRefundByDayAndMode(scope, range) {
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
          mode: "$payment.mode",
        },
        amountPaise: { $sum: "$amountPaise" },
      },
    },
  ]);
}

async function aggregateManualReversalByDayAndMode(scope, range) {
  const match = {
    ...directPaymentMatch(scope),
    status: PaymentStatus.REVERSED,
    reversedAt: { $exists: true, $ne: null },
    reversalReason: { $ne: "GATEWAY_REFUND_COMPLETED" },
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
          mode: "$mode",
        },
        amountPaise: { $sum: "$amountPaise" },
      },
    },
  ]);
}

/**
 * Daily net collection by calendar day and Payment.mode (IST), zero-filled.
 * @param {string[]} modes - explicit modes to include (e.g. CASH, UPI)
 */
export async function aggregateCollectionDailyByModeAccounting(baseMatch, range, modes = []) {
  const { from, to } = range ?? {};
  if (!from || !to || !modes?.length) return { dates: [], cells: [] };

  const scope = paymentScopeFromBaseMatch(baseMatch);
  const grossMatch = {
    ...baseMatch,
    ...dateMatch("paidAt", range),
    mode: { $in: modes },
  };
  const dayBucket = {
    $dateToString: { format: "%Y-%m-%d", date: "$paidAt", timezone: "Asia/Kolkata" },
  };

  const [grossRows, gatewayRows, manualRows] = await Promise.all([
    Payment.aggregate([
      { $match: grossMatch },
      {
        $group: {
          _id: { day: dayBucket, mode: "$mode" },
          grossReceiptsPaise: { $sum: "$amountPaise" },
          paymentCount: { $sum: 1 },
        },
      },
    ]),
    aggregateGatewayRefundByDayAndMode(scope, range),
    aggregateManualReversalByDayAndMode(scope, range),
  ]);

  const cellMap = new Map();
  const touch = (day, mode, patch) => {
    const key = dayModeKey(day, mode);
    const row = cellMap.get(key) ?? {
      date: day,
      mode,
      paymentCount: 0,
      grossReceiptsPaise: 0,
      gatewayRefundOutflowPaise: 0,
      manualCorrectionOutflowPaise: 0,
      netCollectedPaise: 0,
    };
    Object.assign(row, patch);
    cellMap.set(key, row);
  };

  for (const row of grossRows) {
    const mode = row._id.mode;
    if (!modes.includes(mode)) continue;
    touch(row._id.day, mode, {
      grossReceiptsPaise: row.grossReceiptsPaise ?? 0,
      paymentCount: row.paymentCount ?? 0,
    });
  }
  for (const row of gatewayRows) {
    const mode = row._id.mode;
    if (!modes.includes(mode)) continue;
    touch(row._id.day, mode, {
      gatewayRefundOutflowPaise:
        (cellMap.get(dayModeKey(row._id.day, mode))?.gatewayRefundOutflowPaise ?? 0) +
        (row.amountPaise ?? 0),
    });
  }
  for (const row of manualRows) {
    const mode = row._id.mode;
    if (!modes.includes(mode)) continue;
    touch(row._id.day, mode, {
      manualCorrectionOutflowPaise:
        (cellMap.get(dayModeKey(row._id.day, mode))?.manualCorrectionOutflowPaise ?? 0) +
        (row.amountPaise ?? 0),
    });
  }

  const dates = [...iteratePeriodBuckets(from, to, "DAY")];
  const cells = [];
  for (const date of dates) {
    for (const mode of modes) {
      const key = dayModeKey(date, mode);
      const stats = cellMap.get(key) ?? {
        date,
        mode,
        paymentCount: 0,
        grossReceiptsPaise: 0,
        gatewayRefundOutflowPaise: 0,
        manualCorrectionOutflowPaise: 0,
      };
      stats.netCollectedPaise =
        stats.grossReceiptsPaise -
        stats.gatewayRefundOutflowPaise -
        stats.manualCorrectionOutflowPaise;
      cells.push(stats);
    }
  }
  return { dates, cells, modes: [...modes] };
}
