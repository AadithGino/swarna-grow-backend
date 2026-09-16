import { LedgerEntry, Scheme, SchemePlan } from "../../models/index.js";
import { moneyRef, rateRef, weightRef } from "../../lib/money.js";
import { currentGoldRate } from "../tenant.service.js";
import { today } from "../../lib/date.js";
import { baseEnvelope, paginateRows, reportDataScope } from "./report-envelope.js";

const COLUMNS = [
  { key: "label", label: "Plan", type: "text", sticky: true },
  { key: "activeSchemes", label: "Schemes", type: "count", align: "right" },
  { key: "gramsAccrued", label: "Grams owed", type: "weight", align: "right", emphasis: true },
  { key: "amountReceived", label: "Received", type: "currency", align: "right" },
  { key: "liabilityToday", label: "Liability today", type: "currency", align: "right" },
  { key: "averageRatePaid", label: "Avg rate paid", type: "currency", align: "right" },
];

export async function buildGoldAccrualReport(req) {
  const envelope = baseEnvelope(req, "GOLD_ACCRUAL", "Gold accrual & liability");
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
    { $match: { tenantId: req.auth.tenantId, schemeId: { $in: schemeIds }, weightMg: { $gt: 0 } } },
    {
      $group: {
        _id: "$schemeId",
        weightMg: { $sum: "$weightMg" },
        amountPaise: { $sum: { $ifNull: ["$amountPaise", 0] } },
        rateSum: { $sum: { $ifNull: ["$ratePerGramPaise", 0] } },
        rateCount: { $sum: { $cond: [{ $gt: ["$ratePerGramPaise", 0] }, 1, 0] } },
      },
    },
  ]);
  const ledgerMap = new Map(ledgerByScheme.map((r) => [r._id, r]));

  const trendRows = await LedgerEntry.aggregate([
    { $match: { ...scope, weightMg: { $gt: 0 } } },
    { $sort: { effectiveAt: 1 } },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m", date: "$effectiveAt", timezone: "Asia/Kolkata" } },
        weightMg: { $sum: "$weightMg" },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  let cumulative = 0;
  const trendData = trendRows.map((row) => {
    cumulative += row.weightMg;
    return { x: row._id, y: cumulative, yDisplay: weightRef(cumulative).weightDisplay };
  });

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
        rateSum: 0,
        rateCount: 0,
      });
    }
    const row = byPlan.get(planId);
    row.activeSchemes += 1;
    const led = ledgerMap.get(scheme._id);
    if (led) {
      row.weightMg += led.weightMg;
      row.amountPaise += led.amountPaise;
      row.rateSum += led.rateSum;
      row.rateCount += led.rateCount;
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
      const liabilityPaise = ratePaise ? Math.round((row.weightMg * ratePaise) / 1000) : 0;
      const avgRate = row.rateCount ? Math.round(row.rateSum / row.rateCount) : 0;
      return {
        key: row.key,
        label: row.label,
        activeSchemes: row.activeSchemes,
        gramsAccrued: weightRef(row.weightMg),
        amountReceived: moneyRef(row.amountPaise),
        liabilityToday: moneyRef(liabilityPaise),
        averageRatePaid: avgRate ? rateRef(avgRate) : rateRef(0),
      };
    })
    .sort((a, b) => b.gramsAccrued.weightMg - a.gramsAccrued.weightMg);

  const totalWeightMg = tableRows.reduce((sum, r) => sum + r.gramsAccrued.weightMg, 0);
  const totalReceived = tableRows.reduce((sum, r) => sum + r.amountReceived.amountPaise, 0);
  const totalLiability = ratePaise ? Math.round((totalWeightMg * ratePaise) / 1000) : 0;

  const { rows, meta } = paginateRows(tableRows, req.query);

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
        value: moneyRef(Math.max(0, totalLiability - totalReceived)),
        valueType: "currency",
        severity: "INFO",
        note: "Difference between today's value and what customers actually paid.",
      },
    ],
    charts: {
      accrualTrend: {
        chartType: "area",
        title: "Cumulative grams",
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
            data: tableRows.map((row) => ({
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
