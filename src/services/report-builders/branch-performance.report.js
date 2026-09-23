import { Branch, Payment, Scheme, SchemePlan } from "../../models/index.js";
import { moneyRef } from "../../lib/money.js";
import { dateMatch } from "../../lib/query-filters.js";
import {
  baseEnvelope,
  branchNameMap,
  buildCountTrendPoints,
  buildCurrencyTrendPoints,
  paginateRows,
  parseReportFocusId,
  reportDataScope,
  reportTrendGroupBy,
} from "./report-envelope.js";
import {
  netCollectionStatusFilter,
  sumNetAmountPaise,
} from "../../lib/payment-net-aggregation.js";

const COMPARISON_COLUMNS = [
  { key: "label", label: "Showroom", type: "text", sticky: true, sortable: true },
  { key: "collected", label: "Collected", type: "currency", align: "right", emphasis: true, sortable: true },
  { key: "enrolments", label: "Enrolments", type: "count", align: "right", sortable: true },
  { key: "activeSchemes", label: "Active schemes", type: "count", align: "right" },
  { key: "paymentCount", label: "Payments", type: "count", align: "right" },
];

const DETAIL_COLUMNS = [
  { key: "label", label: "Scheme plan", type: "text", sticky: true },
  { key: "enrolments", label: "Enrolments", type: "count", align: "right" },
  { key: "collected", label: "Collected", type: "currency", align: "right", emphasis: true },
  { key: "activeSchemes", label: "Active schemes", type: "count", align: "right" },
];

function mergeBranchMetrics(branches, collectionMap, enrolmentMap, activeMap) {
  return branches.map((branch) => {
    const collected = collectionMap.get(branch._id) ?? {
      amountPaise: 0,
      count: 0,
    };
    return {
      key: branch._id,
      label: branch.name,
      collected: moneyRef(collected.amountPaise),
      enrolments: enrolmentMap.get(branch._id) ?? 0,
      activeSchemes: activeMap.get(branch._id) ?? 0,
      paymentCount: collected.count,
      drilldownPath: `/reports?reportKey=BRANCH_PERFORMANCE&branchId=${branch._id}`,
    };
  });
}

export async function buildBranchPerformanceReport(req) {
  const selectedBranchId = parseReportFocusId(req.query.branchId);
  const envelopeBase = baseEnvelope(
    req,
    "BRANCH_PERFORMANCE",
    "Branch performance",
  );
  const { from, to } = envelopeBase.period;
  const dataScope = reportDataScope(req);
  const tenantId = dataScope.tenantId ?? req.auth.tenantId;
  const groupBy = reportTrendGroupBy(from, to, req.query);
  const lockedBranch = parseReportFocusId(req.scope?.branchId);
  let focusBranchId = selectedBranchId;
  if (lockedBranch && focusBranchId && focusBranchId !== lockedBranch) {
    focusBranchId = lockedBranch;
  }

  const aggregateScope = focusBranchId
    ? { tenantId, branchId: focusBranchId }
    : dataScope;
  const branchQuery = focusBranchId
    ? { tenantId, _id: focusBranchId, active: { $ne: false } }
    : dataScope.branchId
      ? { tenantId, _id: dataScope.branchId, active: { $ne: false } }
      : { tenantId, active: { $ne: false } };

  const [branches, byBranchCollection, byBranchEnrolments, byBranchActive] =
    await Promise.all([
      Branch.find(branchQuery)
        .select("_id name code")
        .sort({ name: 1 })
        .lean(),
      Payment.aggregate([
        {
          $match: {
            ...aggregateScope,
            ...netCollectionStatusFilter(),
            ...dateMatch("paidAt", { from, to }),
          },
        },
        {
          $group: {
            _id: "$branchId",
            amountPaise: sumNetAmountPaise(),
            count: { $sum: 1 },
          },
        },
      ]),
      Scheme.aggregate([
        {
          $match: {
            ...aggregateScope,
            ...dateMatch("createdAt", { from, to }),
          },
        },
        { $group: { _id: "$branchId", count: { $sum: 1 } } },
      ]),
      Scheme.aggregate([
        {
          $match: {
            ...aggregateScope,
            status: { $in: ["ACTIVE", "LOCKED"] },
          },
        },
        { $group: { _id: "$branchId", count: { $sum: 1 } } },
      ]),
    ]);

  const collectionMap = new Map(byBranchCollection.map((r) => [r._id, r]));
  const enrolmentMap = new Map(
    byBranchEnrolments.map((r) => [r._id, r.count]),
  );
  const activeMap = new Map(byBranchActive.map((r) => [r._id, r.count]));

  if (focusBranchId) {
    const branchNames = await branchNameMap(tenantId, [focusBranchId]);
    const branchLabel = branchNames.get(focusBranchId) ?? focusBranchId;
    const branchScope = { tenantId, branchId: focusBranchId };

    const [dailyCollection, dailyEnrolments, byPlanCollection, byPlanEnrolments, byPlanActive] =
      await Promise.all([
        Payment.aggregate([
          {
            $match: {
              ...branchScope,
              ...netCollectionStatusFilter(),
              ...dateMatch("paidAt", { from, to }),
            },
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$paidAt",
                  timezone: "Asia/Kolkata",
                },
              },
              amountPaise: sumNetAmountPaise(),
            },
          },
          { $sort: { _id: 1 } },
        ]),
        Scheme.aggregate([
          {
            $match: {
              ...branchScope,
              ...dateMatch("createdAt", { from, to }),
            },
          },
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
        ]),
        Payment.aggregate([
          {
            $match: {
              ...branchScope,
              ...netCollectionStatusFilter(),
              ...dateMatch("paidAt", { from, to }),
            },
          },
          {
            $lookup: {
              from: "schemes",
              localField: "schemeId",
              foreignField: "_id",
              as: "scheme",
            },
          },
          { $unwind: { path: "$scheme", preserveNullAndEmptyArrays: true } },
          {
            $group: {
              _id: "$scheme.planId",
              amountPaise: sumNetAmountPaise(),
              label: { $first: "$scheme.planSnapshot.name" },
            },
          },
        ]),
        Scheme.aggregate([
          {
            $match: {
              ...branchScope,
              ...dateMatch("createdAt", { from, to }),
            },
          },
          {
            $group: {
              _id: "$planId",
              count: { $sum: 1 },
              label: { $first: "$planSnapshot.name" },
            },
          },
        ]),
        Scheme.aggregate([
          {
            $match: {
              ...branchScope,
              status: { $in: ["ACTIVE", "LOCKED"] },
            },
          },
          { $group: { _id: "$planId", count: { $sum: 1 } } },
        ]),
      ]);

    const planIds = [
      ...new Set([
        ...byPlanCollection.map((r) => r._id).filter(Boolean),
        ...byPlanEnrolments.map((r) => r._id).filter(Boolean),
      ]),
    ];
    const plans = await SchemePlan.find({ _id: { $in: planIds } })
      .select("_id name")
      .lean();
    const planNameMap = new Map(plans.map((p) => [p._id, p.name]));

    const planCollectionMap = new Map(
      byPlanCollection.map((r) => [r._id, r.amountPaise ?? 0]),
    );
    const planEnrolmentMap = new Map(
      byPlanEnrolments.map((r) => [r._id, r.count ?? 0]),
    );
    const planActiveMap = new Map(
      byPlanActive.map((r) => [r._id, r.count ?? 0]),
    );

    const tableRows = planIds
      .map((planId) => ({
        key: planId,
        label:
          planNameMap.get(planId) ??
          byPlanEnrolments.find((r) => r._id === planId)?.label ??
          planId,
        enrolments: planEnrolmentMap.get(planId) ?? 0,
        collected: moneyRef(planCollectionMap.get(planId) ?? 0),
        activeSchemes: planActiveMap.get(planId) ?? 0,
        drilldownPath: `/reports?reportKey=SCHEME_PERFORMANCE&planId=${planId}`,
      }))
      .sort((a, b) => b.collected.amountPaise - a.collected.amountPaise);

    const branchRow = mergeBranchMetrics(
      [{ _id: focusBranchId, name: branchLabel }],
      collectionMap,
      enrolmentMap,
      activeMap,
    )[0] ?? {
      collected: moneyRef(0),
      enrolments: 0,
      activeSchemes: 0,
      paymentCount: 0,
    };

    const { rows, meta } = paginateRows(tableRows, req.query);

    return {
      ...envelopeBase,
      title: `${branchLabel} performance`,
      scope: {
        level: "BRANCH",
        label: branchLabel,
        branchId: focusBranchId,
      },
      summary: [
        {
          key: "COLLECTED",
          label: "Collected",
          value: branchRow.collected,
          valueType: "currency",
        },
        {
          key: "ENROLMENTS",
          label: "New enrolments",
          value: branchRow.enrolments,
          valueType: "count",
        },
        {
          key: "ACTIVE",
          label: "Active schemes",
          value: branchRow.activeSchemes,
          valueType: "count",
        },
        {
          key: "PAYMENTS",
          label: "Payments",
          value: branchRow.paymentCount,
          valueType: "count",
        },
      ],
      charts: {
        collectionTrend: {
          chartType: "line",
          title: "Collection trend",
          subtitle: `Grouped by ${groupBy.toLowerCase()}`,
          yAxis: { type: "currency", label: "Amount" },
          series: [
            {
              key: "COLLECTED",
              name: "Collected",
              data: buildCurrencyTrendPoints(
                dailyCollection,
                from,
                to,
                groupBy,
              ),
            },
          ],
        },
        enrolmentTrend: {
          chartType: "line",
          title: "Enrolment trend",
          subtitle: `Grouped by ${groupBy.toLowerCase()}`,
          yAxis: { type: "count", label: "Enrolments" },
          series: [
            {
              key: "ENROLMENTS",
              name: "Enrolments",
              data: buildCountTrendPoints(dailyEnrolments, from, to, groupBy),
            },
          ],
        },
        collectedByPlan: {
          chartType: "horizontalBar",
          title: "Collection by plan",
          yAxis: { type: "currency", label: "Amount" },
          series: [
            {
              key: "COLLECTED",
              name: "Collected",
              data: tableRows.map((row) => ({
                x: row.label,
                y: row.collected.amountPaise,
                yDisplay: row.collected.amountDisplay,
              })),
            },
          ],
        },
        enrolmentsByPlan: {
          chartType: "horizontalBar",
          title: "Enrolments by plan",
          yAxis: { type: "count", label: "Enrolments" },
          series: [
            {
              key: "ENROLMENTS",
              name: "Enrolments",
              data: tableRows.map((row) => ({
                x: row.label,
                y: row.enrolments,
              })),
            },
          ],
        },
      },
      columns: DETAIL_COLUMNS,
      rows,
      meta,
    };
  }

  const tableRows = mergeBranchMetrics(
    branches,
    collectionMap,
    enrolmentMap,
    activeMap,
  ).sort((a, b) => b.collected.amountPaise - a.collected.amountPaise);

  const totalCollected = tableRows.reduce(
    (sum, row) => sum + row.collected.amountPaise,
    0,
  );
  const totalEnrolments = tableRows.reduce(
    (sum, row) => sum + row.enrolments,
    0,
  );
  const totalActive = tableRows.reduce(
    (sum, row) => sum + row.activeSchemes,
    0,
  );
  const totalPayments = tableRows.reduce(
    (sum, row) => sum + row.paymentCount,
    0,
  );

  const { rows, meta } = paginateRows(tableRows, req.query);

  return {
    ...envelopeBase,
    title: "Branch performance comparison",
    summary: [
      {
        key: "COLLECTED",
        label: "Total collected",
        value: moneyRef(totalCollected),
        valueType: "currency",
      },
      {
        key: "ENROLMENTS",
        label: "New enrolments",
        value: totalEnrolments,
        valueType: "count",
      },
      {
        key: "ACTIVE",
        label: "Active schemes",
        value: totalActive,
        valueType: "count",
      },
      {
        key: "BRANCHES",
        label: "Showrooms",
        value: tableRows.length,
        valueType: "count",
      },
      {
        key: "PAYMENTS",
        label: "Payments",
        value: totalPayments,
        valueType: "count",
      },
    ],
    charts: {
      collectionByBranch: {
        chartType: "horizontalBar",
        title: "Collection by showroom",
        yAxis: { type: "currency", label: "Amount" },
        series: [
          {
            key: "COLLECTED",
            name: "Collected",
            data: tableRows.map((row) => ({
              x: row.label,
              y: row.collected.amountPaise,
              yDisplay: row.collected.amountDisplay,
            })),
          },
        ],
      },
      enrolmentsByBranch: {
        chartType: "horizontalBar",
        title: "Enrolments by showroom",
        yAxis: { type: "count", label: "Enrolments" },
        series: [
          {
            key: "ENROLMENTS",
            name: "Enrolments",
            data: tableRows.map((row) => ({
              x: row.label,
              y: row.enrolments,
            })),
          },
        ],
      },
    },
    columns: COMPARISON_COLUMNS,
    rows,
    meta,
  };
}
