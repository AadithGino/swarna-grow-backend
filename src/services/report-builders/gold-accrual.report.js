import { LedgerEntry, Scheme, SchemePlan } from "../../models/index.js";
import { moneyRef, rateRef, weightRef } from "../../lib/money.js";
import {
  displayNetGoldAmountPaise,
  displayNetGoldWeightMg,
  goldAccrualLiabilityPaise,
  goldAccrualMongoAmountDeltaExpr,
  goldAccrualMongoWeightDeltaExpr,
  goldAccrualRateExposurePaise,
  weightedAccrualRatePerGramPaise,
} from "../../lib/gold-accrual-netting.js";
import { currentGoldRate } from "../tenant.service.js";
import { today } from "../../lib/date.js";
import { dateMatch } from "../../lib/query-filters.js";
import {
  formatTrendBucketLabel,
} from "../../lib/analytics-period.js";
import {
  baseEnvelope,
  paginateRows,
  reportDataScope,
  reportTrendGroupBy,
  rollupDailyMetric,
} from "./report-envelope.js";

const COLUMNS = [
  { key: "label", label: "Plan", type: "text", sticky: true },
  { key: "activeSchemes", label: "Schemes", type: "count", align: "right" },
  { key: "gramsAccrued", label: "Grams owed", type: "weight", align: "right", emphasis: true },
  { key: "amountReceived", label: "Received", type: "currency", align: "right" },
  { key: "liabilityToday", label: "Liability today", type: "currency", align: "right" },
  { key: "averageRatePaid", label: "Avg rate paid", type: "currency", align: "right" },
];

const weightDeltaExpr = goldAccrualMongoWeightDeltaExpr();
const amountDeltaExpr = goldAccrualMongoAmountDeltaExpr();

async function buildCumulativeGramsTrend(schemeIds, tenantId, from, to, groupBy) {
  if (!schemeIds.length || !from || !to) return [];

  const baseMatch = {
    tenantId,
    schemeId: { $in: schemeIds },
  };
  const [openingRow, dailyRows] = await Promise.all([
    LedgerEntry.aggregate([
      {
        $match: {
          ...baseMatch,
          effectiveAt: { $lt: new Date(`${from}T00:00:00+05:30`) },
        },
      },
      {
        $group: {
          _id: null,
          weightMg: { $sum: weightDeltaExpr },
        },
      },
    ]),
    LedgerEntry.aggregate([
      {
        $match: {
          ...baseMatch,
          ...dateMatch("effectiveAt", { from, to }),
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$effectiveAt",
              timezone: "Asia/Kolkata",
            },
          },
          weightMg: { $sum: weightDeltaExpr },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const dailyMap = new Map(dailyRows.map((row) => [row._id, row.weightMg]));
  const rolled = rollupDailyMetric(dailyRows, from, to, groupBy, "weightMg");
  let cumulative = openingRow[0]?.weightMg ?? 0;

  return rolled.map((bucket) => {
    cumulative +=
      groupBy === "DAY"
        ? (dailyMap.get(bucket.key) ?? 0)
        : (Number(bucket.value) || 0);
    const displayMg = displayNetGoldWeightMg(cumulative);
    return {
      x: bucket.key,
      xDisplay: formatTrendBucketLabel(bucket.key, groupBy),
      y: displayMg,
      yDisplay: weightRef(displayMg).weightDisplay,
    };
  });
}

export async function buildGoldAccrualReport(req) {
  const envelope = baseEnvelope(req, "GOLD_ACCRUAL", "Gold accrual & liability");
  const { from, to } = envelope.period;
  const groupBy = reportTrendGroupBy(from, to, req.query);
  const scope = reportDataScope(req);
  const branchId = scope.branchId ?? null;
  const rateRow = await currentGoldRate({ tenantId: req.auth.tenantId, branchId }, today());
  const ratePaise = rateRow?.ratePerGramPaise ?? 0;

  const activeSchemes = await Scheme.find({
    ...scope,
    status: { $in: ["ACTIVE", "LOCKED", "MATURED"] },
    valueBasis: "GOLD_WEIGHT",
    ...(req.query.planId ? { planId: req.query.planId } : {}),
  })
    .select("_id planId planSnapshot")
    .lean();

  const schemeIds = activeSchemes.map((s) => s._id);
  const ledgerByScheme = await LedgerEntry.aggregate([
    { $match: { tenantId: req.auth.tenantId, schemeId: { $in: schemeIds } } },
    {
      $group: {
        _id: "$schemeId",
        weightMg: { $sum: weightDeltaExpr },
        amountPaise: { $sum: amountDeltaExpr },
      },
    },
  ]);
  const ledgerMap = new Map(ledgerByScheme.map((r) => [r._id, r]));

  const trendData = await buildCumulativeGramsTrend(
    schemeIds,
    req.auth.tenantId,
    from,
    to,
    groupBy,
  );

  const byPlan = new Map();
  for (const scheme of activeSchemes) {
    const planId = scheme.planId;
    if (!byPlan.has(planId)) {
      byPlan.set(planId, {
        key: planId,
        label: scheme.planSnapshot?.name ?? planId,
        activeSchemes: 0,
        weightMg: 0,
        amountPaise: 0,
      });
    }
    const row = byPlan.get(planId);
    row.activeSchemes += 1;
    const led = ledgerMap.get(scheme._id);
    if (led) {
      row.weightMg += led.weightMg;
      row.amountPaise += led.amountPaise;
    }
  }

  const planIds = [...byPlan.keys()];
  const plans = await SchemePlan.find({ _id: { $in: planIds } }).select("_id name").lean();
  for (const plan of plans) {
    const row = byPlan.get(plan._id);
    if (row) row.label = plan.name;
  }

  const tableRows = [...byPlan.values()]
    .map((row) => {
      const netWeightMg = row.weightMg;
      const netAmountPaise = row.amountPaise;
      const displayWeightMg = displayNetGoldWeightMg(netWeightMg);
      const displayAmountPaise = displayNetGoldAmountPaise(netAmountPaise);
      const liabilityPaise = goldAccrualLiabilityPaise(netWeightMg, ratePaise);
      const avgRate = weightedAccrualRatePerGramPaise(netAmountPaise, netWeightMg);
      return {
        key: row.key,
        label: row.label,
        activeSchemes: row.activeSchemes,
        gramsAccrued: weightRef(displayWeightMg),
        amountReceived: moneyRef(displayAmountPaise),
        liabilityToday: moneyRef(liabilityPaise),
        averageRatePaid: avgRate ? rateRef(avgRate) : rateRef(0),
        _netWeightMg: netWeightMg,
        _netAmountPaise: netAmountPaise,
      };
    })
    .sort((a, b) => b.gramsAccrued.weightMg - a.gramsAccrued.weightMg);

  const totalNetWeightMg = tableRows.reduce((sum, r) => sum + r._netWeightMg, 0);
  const totalNetAmountPaise = tableRows.reduce((sum, r) => sum + r._netAmountPaise, 0);
  const totalWeightMg = displayNetGoldWeightMg(totalNetWeightMg);
  const totalReceived = displayNetGoldAmountPaise(totalNetAmountPaise);
  const totalLiability = goldAccrualLiabilityPaise(totalNetWeightMg, ratePaise);
  const totalExposure = goldAccrualRateExposurePaise(totalLiability, totalNetAmountPaise);

  const publicRows = tableRows.map(({ _netWeightMg, _netAmountPaise, ...row }) => row);
  const { rows, meta } = paginateRows(publicRows, req.query);

  return {
    ...envelope,
    valuationRate: rateRow
      ? {
          ratePerGramPaise: rateRow.ratePerGramPaise,
          ratePerGramDisplay: rateRef(rateRow.ratePerGramPaise).ratePerGramDisplay,
          asOf: `${rateRow.effectiveDate}T09:00:00+05:30`,
        }
      : undefined,
    summary: [
      { key: "TOTAL_GRAMS", label: "Gold owed", value: weightRef(totalWeightMg), valueType: "weight" },
      { key: "LIABILITY_TODAY", label: "Liability at today's rate", value: moneyRef(totalLiability), valueType: "currency" },
      { key: "AMOUNT_RECEIVED", label: "Amount received", value: moneyRef(totalReceived), valueType: "currency" },
      {
        key: "RATE_EXPOSURE",
        label: "Rate exposure",
        value: moneyRef(totalExposure),
        valueType: "currency",
        severity: "INFO",
        note: "Difference between today's value and what customers actually paid.",
      },
    ],
    charts: {
      accrualTrend: {
        chartType: "line",
        title: "Cumulative grams",
        subtitle: `Running total of gold credited to active schemes · grouped by ${groupBy.toLowerCase()}`,
        yAxis: { type: "weight", label: "Grams" },
        series: [{ key: "GOLD_ACCRUED", name: "Grams", data: trendData }],
      },
      byPlan: {
        chartType: "horizontalBar",
        title: "Grams by plan",
        yAxis: { type: "weight", label: "Grams" },
        series: [
          {
            key: "grams",
            name: "Grams",
            data: publicRows.map((row) => ({
              x: row.label,
              y: row.gramsAccrued.weightMg,
              yDisplay: row.gramsAccrued.weightDisplay,
            })),
          },
        ],
      },
    },
    columns: COLUMNS,
    rows,
    meta,
  };
}
