import { aggregateCollectionPeriod, collectionPeriodBaseMatch } from "../../lib/collection-period-aggregation.js";
import {
  aggregateCollectionDailyAccounting,
  aggregateCollectionDailyByModeAccounting,
} from "../../lib/collection-daily-accounting.js";
import { moneyRef } from "../../lib/money.js";
import { reportDataScope, schemeIdsForPlan } from "../report-builders/report-envelope.js";
import { assertReportRange } from "../report-builders/report-envelope.js";
import {
  formatAppliedDateLabel,
  resolveActionDateBounds,
} from "./assistant-date-window.js";
import {
  assertAnalyticsOutputMatchesPlan,
  defaultCollectionAnalyticsPlan,
  modeColumnKey,
  modeColumnLabel,
} from "./collection-analytics-plan.js";

export async function runCollectionDailyAssistant(req, action) {
  const query = { ...(req.query ?? {}) };
  const filters = action.filters ?? {};
  if (filters.from) query.from = filters.from;
  if (filters.to) query.to = filters.to;
  if (filters.period) query.period = filters.period;
  if (filters.branchId) query.branchId = filters.branchId;
  if (filters.planId) query.planId = filters.planId;
  if (!query.period && !query.from && !query.to) query.period = "THIS_MONTH";
  const { from, to } = assertReportRange(query);

  const analytics = {
    ...defaultCollectionAnalyticsPlan(),
    ...(action.analytics ?? filters.analytics ?? {}),
  };

  const scope = reportDataScope({ ...req, query });
  const schemeIds = await schemeIdsForPlan(scope, query.planId);
  const baseMatch = collectionPeriodBaseMatch(
    scope,
    schemeIds ? { schemeId: { $in: schemeIds } } : {},
  );

  const periodTotals = await aggregateCollectionPeriod(baseMatch, { from, to });

  const compareModes = analytics.compareModes?.length ? analytics.compareModes : null;
  const modeComparison =
    compareModes &&
    analytics.dimensions?.includes("mode") &&
    analytics.dimensions?.includes("day");

  let dailyRows;
  let modeMatrix = null;
  if (modeComparison) {
    modeMatrix = await aggregateCollectionDailyByModeAccounting(baseMatch, { from, to }, compareModes);
    dailyRows = await aggregateCollectionDailyAccounting(baseMatch, { from, to });
  } else {
    dailyRows = await aggregateCollectionDailyAccounting(baseMatch, { from, to });
  }

  const dailyNetSum = dailyRows.reduce((acc, row) => acc + row.netCollectedPaise, 0);

  return {
    from,
    to,
    periodLabel: formatAppliedDateLabel(from, to),
    summary: periodTotals,
    dailyRows,
    modeMatrix,
    analytics,
    reconciled: dailyNetSum === periodTotals.amountPaise,
    dailyNetSum,
  };
}

function pivotModeComparisonRows(modeMatrix, metricKey) {
  const { dates, cells, modes } = modeMatrix;
  const valueField =
    metricKey === "gross_receipts" ? "grossReceiptsPaise" : "netCollectedPaise";
  const byDate = new Map();
  for (const cell of cells) {
    if (!byDate.has(cell.date)) byDate.set(cell.date, { date: cell.date, key: cell.date });
    const row = byDate.get(cell.date);
    row[`${modeColumnKey(cell.mode)}Net`] = moneyRef(cell[valueField] ?? 0);
    row[`${modeColumnKey(cell.mode)}Count`] = cell.paymentCount ?? 0;
  }
  return dates.map((date) => byDate.get(date) ?? { date, key: date });
}

export function bundlePayloadFromCollectionDaily(result, action) {
  const { from, to, periodLabel, summary, dailyRows, modeMatrix, analytics } = result;
  const compareModes = analytics?.compareModes ?? [];
  const isModeComparison =
    compareModes.length >= 2 && analytics?.dimensions?.includes("mode");

  let columns;
  let rows;
  let chart;

  if (isModeComparison && modeMatrix) {
    columns = [{ key: "date", label: "Date", type: "text" }];
    for (const mode of compareModes) {
      const key = `${modeColumnKey(mode)}Net`;
      columns.push({
        key,
        label: `${modeColumnLabel(mode)} (net)`,
        type: "currency",
        modeKey: mode,
      });
    }
    rows = pivotModeComparisonRows(modeMatrix, analytics.metric);
    chart = {
      type: "line",
      title: "Daily collection by payment mode (net)",
      yAxisType: "currency",
      series: compareModes.map((mode) => ({
        name: modeColumnLabel(mode),
        modeKey: mode,
        data: modeMatrix.dates.map((date) => {
          const cell = modeMatrix.cells.find((c) => c.date === date && c.mode === mode);
          return { x: date, y: cell?.netCollectedPaise ?? 0 };
        }),
      })),
    };
  } else {
    columns = [
      { key: "date", label: "Date", type: "text" },
      { key: "paymentCount", label: "Payments", type: "count" },
      { key: "grossReceipts", label: "Gross receipts", type: "currency" },
      { key: "gatewayRefundOutflow", label: "Gateway refund outflow", type: "currency" },
      { key: "manualCorrectionOutflow", label: "Manual correction outflow", type: "currency" },
      { key: "netCollected", label: "Net collected", type: "currency" },
    ];
    rows = dailyRows.map((row) => ({
      key: row.date,
      date: row.date,
      paymentCount: row.paymentCount,
      grossReceipts: moneyRef(row.grossReceiptsPaise),
      gatewayRefundOutflow: moneyRef(row.gatewayRefundOutflowPaise),
      manualCorrectionOutflow: moneyRef(row.manualCorrectionOutflowPaise),
      netCollected: moneyRef(row.netCollectedPaise),
    }));
    chart = {
      type: "line",
      title: "Daily net collected",
      yAxisType: "currency",
      series: [
        {
          name: "Net collected",
          data: dailyRows.map((row) => ({
            x: row.date,
            y: row.netCollectedPaise,
          })),
        },
      ],
    };
  }

  const statCards = [
    {
      label: "Gross receipts",
      value: summary.grossAmountPaise,
      valueType: "currency",
      metricKey: "GROSS_COLLECTED",
    },
    {
      label: "Net collected",
      value: summary.amountPaise,
      valueType: "currency",
      metricKey: "NET_COLLECTED",
    },
    { label: "Payments", value: summary.count, valueType: "count", metricKey: "PAYMENT_COUNT" },
  ];

  const groupingLabel = isModeComparison
    ? `day × ${compareModes.map(modeColumnLabel).join(" vs ")}`
    : "day";

  const appliedFilters = {
    dateRange: periodLabel ?? formatAppliedDateLabel(from, to),
    timezone: "Asia/Kolkata",
    metric: analytics?.metric ?? "net_collected",
    grouping: groupingLabel,
    compareModes: isModeComparison ? compareModes.map(modeColumnLabel) : undefined,
    subject: "tenant",
  };

  const conformance = assertAnalyticsOutputMatchesPlan(analytics, {
    compareModes: isModeComparison ? compareModes : [],
  });

  const summaryText = isModeComparison
    ? `Daily collection comparison · ${periodLabel ?? `${from} – ${to}`}`
    : `Daily collection · ${periodLabel ?? `${from} – ${to}`}`;

  return {
    summaryText,
    statCards,
    chart,
    table: { columns, rows },
    vizHint: isModeComparison ? "mode-comparison-line" : "time-line",
    action,
    exportRecommended: rows.length > 50,
    exportable: {
      entity: "collectionDaily",
      fields: columns.map((c) => c.key),
    },
    appliedFilters,
    meta: {
      from,
      to,
      reconciled: result.reconciled,
      resolvedBounds: resolveActionDateBounds(action),
      analytics,
      conformance,
    },
  };
}
