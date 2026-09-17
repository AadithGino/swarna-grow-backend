import { Scheme, SchemePlan } from "../../models/index.js";
import { moneyRef } from "../../lib/money.js";
import { dateMatch } from "../../lib/query-filters.js";
import {
  baseEnvelope,
  buildCountTrendPoints,
  paginateRows,
  reportDataScope,
  reportTrendGroupBy,
} from "./report-envelope.js";

const COLUMNS = [
  { key: "label", label: "Plan", type: "text", sticky: true },
  { key: "enrolments", label: "Enrolments", type: "count", align: "right" },
  { key: "totalCommitted", label: "Committed", type: "currency", align: "right" },
  { key: "averageInstallment", label: "Avg installment", type: "currency", align: "right" },
  { key: "firstInstallmentCollectedCount", label: "First paid", type: "count", align: "right" },
];

function schemeCommittedPaise(scheme) {
  const instAmt =
    scheme.installmentAmountPaise ?? scheme.installments?.[0]?.amountPaise ?? 0;
  const tenure =
    scheme.installments?.length ?? scheme.planSnapshot?.installmentCount ?? 0;
  return instAmt * (tenure || 1);
}

export async function buildEnrolmentReport(req) {
  const envelope = baseEnvelope(req, "ENROLMENT", "Enrolment report");
  const { from, to } = envelope.period;
  const scope = reportDataScope(req);
  const periodFilter = dateMatch("createdAt", { from, to });
  const planFilter = req.query.planId ? { planId: req.query.planId } : {};

  const schemes = await Scheme.find({
    ...scope,
    ...periodFilter,
    ...planFilter,
  })
    .select(
      "_id planId planSnapshot installmentAmountPaise installments startDate createdAt",
    )
    .lean();

  const planIds = [...new Set(schemes.map((s) => s.planId))];
  const plans = await SchemePlan.find({ _id: { $in: planIds } })
    .select("_id name code")
    .lean();
  const planMap = new Map(plans.map((p) => [p._id, p]));

  const byPlan = new Map();
  let totalCommitted = 0;

  for (const scheme of schemes) {
    const planId = scheme.planId;
    if (!byPlan.has(planId)) {
      const plan = planMap.get(planId);
      byPlan.set(planId, {
        key: planId,
        label: plan?.name ?? scheme.planSnapshot?.name ?? planId,
        enrolments: 0,
        committedPaise: 0,
        installmentSum: 0,
        firstPaid: 0,
      });
    }
    const row = byPlan.get(planId);
    row.enrolments += 1;
    const instAmt =
      scheme.installmentAmountPaise ?? scheme.installments?.[0]?.amountPaise ?? 0;
    const committed = schemeCommittedPaise(scheme);
    row.committedPaise += committed;
    row.installmentSum += instAmt;
    totalCommitted += committed;

    const first = scheme.installments?.[0];
    if (first && (first.paidPaise ?? 0) > 0) {
      row.firstPaid += 1;
    }
  }

  const tableRows = [...byPlan.values()]
    .map((row) => ({
      key: row.key,
      label: row.label,
      enrolments: row.enrolments,
      totalCommitted: moneyRef(row.committedPaise),
      averageInstallment: moneyRef(
        row.enrolments ? Math.round(row.installmentSum / row.enrolments) : 0,
      ),
      firstInstallmentCollectedCount: row.firstPaid,
    }))
    .sort((a, b) => b.enrolments - a.enrolments);

  const enrolmentCount = schemes.length;
  const avgInstallment = enrolmentCount
    ? Math.round(
        schemes.reduce(
          (sum, s) =>
            sum +
            (s.installmentAmountPaise ?? s.installments?.[0]?.amountPaise ?? 0),
          0,
        ) / enrolmentCount,
      )
    : 0;

  const groupBy = reportTrendGroupBy(from, to, req.query);
  const dailyEnrolments = await Scheme.aggregate([
    { $match: { ...scope, ...periodFilter, ...planFilter } },
    {
      $group: {
        _id: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$createdAt",
            timezone: "Asia/Kolkata",
          },
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  const enrolmentTrend = buildCountTrendPoints(
    dailyEnrolments,
    from,
    to,
    groupBy,
  );

  return {
    ...envelope,
    summary: [
      {
        key: "NEW_ENROLMENTS",
        label: "New enrolments",
        value: enrolmentCount,
        valueType: "count",
      },
      {
        key: "COMMITTED",
        label: "Total committed",
        value: moneyRef(totalCommitted),
        valueType: "currency",
      },
      {
        key: "AVG_INSTALLMENT",
        label: "Average installment",
        value: moneyRef(avgInstallment),
        valueType: "currency",
      },
    ],
    charts: {
      enrolmentTrend: {
        chartType: "line",
        title: "Enrolments over time",
        subtitle: `Grouped by ${groupBy.toLowerCase()}`,
        yAxis: { type: "count", label: "Enrolments" },
        series: [
          {
            key: "ENROLMENTS",
            name: "Enrolments",
            data: enrolmentTrend,
          },
        ],
      },
      byPlan: {
        chartType: "horizontalBar",
        title: "By plan",
        yAxis: { type: "count", label: "Enrolments" },
        series: [
          {
            key: "enrolments",
            name: "Enrolments",
            data: tableRows.map((row) => ({ x: row.label, y: row.enrolments })),
          },
        ],
      },
    },
    columns: COLUMNS,
    ...paginateRows(tableRows, req.query),
  };
}
