import { Payment, Scheme, SchemePlan } from "../../models/index.js";
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

const COMPARISON_COLUMNS = [
  { key: "label", label: "Scheme plan", type: "text", sticky: true, sortable: true },
  { key: "enrolments", label: "Enrolments", type: "count", align: "right", sortable: true },
  { key: "collected", label: "Collected", type: "currency", align: "right", emphasis: true, sortable: true },
  { key: "activeSchemes", label: "Active schemes", type: "count", align: "right" },
  { key: "paymentCount", label: "Payments", type: "count", align: "right" },
];

const DETAIL_COLUMNS = [
  { key: "label", label: "Showroom", type: "text", sticky: true },
  { key: "enrolments", label: "Enrolments", type: "count", align: "right" },
  { key: "collected", label: "Collected", type: "currency", align: "right", emphasis: true },
  { key: "activeSchemes", label: "Active schemes", type: "count", align: "right" },
];

function schemeCommittedPaise(scheme) {
  const instAmt =
    scheme.installmentAmountPaise ?? scheme.installments?.[0]?.amountPaise ?? 0;
  const tenure =
    scheme.installments?.length ?? scheme.planSnapshot?.installmentCount ?? 0;
  return instAmt * (tenure || 1);
}

export async function buildSchemePerformanceReport(req) {
  const selectedPlanId = parseReportFocusId(req.query.planId);
  const envelopeBase = baseEnvelope(
    req,
    "SCHEME_PERFORMANCE",
    "Scheme performance",
  );
  const { from, to } = envelopeBase.period;
  const scope = reportDataScope(req);
  const tenantId = scope.tenantId ?? req.auth.tenantId;
  const groupBy = reportTrendGroupBy(from, to, req.query);

  const planFilter = selectedPlanId ? { planId: selectedPlanId } : {};

  const [plans, byPlanEnrolments, schemeIdsForPayments] = await Promise.all([
    SchemePlan.find({
      tenantId,
      ...(selectedPlanId ? { _id: selectedPlanId } : {}),
      status: { $in: ["ACTIVE", "INACTIVE"] },
    })
      .select("_id name code")
      .sort({ name: 1 })
      .lean(),
    Scheme.aggregate([
      {
        $match: {
          ...scope,
          ...planFilter,
          ...dateMatch("createdAt", { from, to }),
        },
      },
      { $group: { _id: "$planId", count: { $sum: 1 } } },
    ]),
    Scheme.find({ ...scope, ...planFilter })
      .select("_id planId")
      .lean(),
  ]);

  const planSchemeIds = schemeIdsForPayments.map((s) => s._id);
  const paymentMatch = {
    tenantId,
    status: "SUCCESS",
    schemeId: { $in: planSchemeIds.length ? planSchemeIds : ["__none__"] },
    ...dateMatch("paidAt", { from, to }),
    ...(scope.branchId ? { branchId: scope.branchId } : {}),
  };

  const [byPlanCollection, byPlanActive, activeSchemesForCommitted] =
    await Promise.all([
      Payment.aggregate([
        { $match: paymentMatch },
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
            amountPaise: { $sum: "$amountPaise" },
            count: { $sum: 1 },
          },
        },
      ]),
      Scheme.aggregate([
        {
          $match: {
            ...scope,
            ...planFilter,
            status: { $in: ["ACTIVE", "LOCKED"] },
          },
        },
        { $group: { _id: "$planId", count: { $sum: 1 } } },
      ]),
      Scheme.find({
        ...scope,
        ...planFilter,
        status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED"] },
      })
        .select("planId installmentAmountPaise installments planSnapshot")
        .lean(),
    ]);

  const enrolmentMap = new Map(
    byPlanEnrolments.map((r) => [r._id, r.count ?? 0]),
  );
  const collectionMap = new Map(
    byPlanCollection.map((r) => [
      r._id,
      { amountPaise: r.amountPaise ?? 0, count: r.count ?? 0 },
    ]),
  );
  const activeMap = new Map(byPlanActive.map((r) => [r._id, r.count ?? 0]));

  const committedByPlan = new Map();
  for (const scheme of activeSchemesForCommitted) {
    const planId = scheme.planId;
    committedByPlan.set(
      planId,
      (committedByPlan.get(planId) ?? 0) + schemeCommittedPaise(scheme),
    );
  }

  if (selectedPlanId) {
    const plan = plans[0];
    const planLabel = plan?.name ?? selectedPlanId;

    const [dailyCollection, dailyEnrolments, byBranchEnrolments, byBranchCollection, byBranchActive, statusCounts] =
      await Promise.all([
        Payment.aggregate([
          { $match: paymentMatch },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$paidAt",
                  timezone: "Asia/Kolkata",
                },
              },
              amountPaise: { $sum: "$amountPaise" },
            },
          },
          { $sort: { _id: 1 } },
        ]),
        Scheme.aggregate([
          {
            $match: {
              ...scope,
              planId: selectedPlanId,
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
        Scheme.aggregate([
          {
            $match: {
              ...scope,
              planId: selectedPlanId,
              ...dateMatch("createdAt", { from, to }),
            },
          },
          { $group: { _id: "$branchId", count: { $sum: 1 } } },
        ]),
        Payment.aggregate([
          { $match: paymentMatch },
          {
            $group: {
              _id: "$branchId",
              amountPaise: { $sum: "$amountPaise" },
            },
          },
        ]),
        Scheme.aggregate([
          {
            $match: {
              ...scope,
              planId: selectedPlanId,
              status: { $in: ["ACTIVE", "LOCKED"] },
            },
          },
          { $group: { _id: "$branchId", count: { $sum: 1 } } },
        ]),
        Scheme.aggregate([
          {
            $match: {
              ...scope,
              planId: selectedPlanId,
            },
          },
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ]),
      ]);

    const branchIds = [
      ...new Set([
        ...byBranchEnrolments.map((r) => r._id),
        ...byBranchCollection.map((r) => r._id),
      ]),
    ].filter(Boolean);
    const branchNames = await branchNameMap(tenantId, branchIds);

    const branchEnrolMap = new Map(
      byBranchEnrolments.map((r) => [r._id, r.count ?? 0]),
    );
    const branchCollectionMap = new Map(
      byBranchCollection.map((r) => [r._id, r.amountPaise ?? 0]),
    );
    const branchActiveMap = new Map(
      byBranchActive.map((r) => [r._id, r.count ?? 0]),
    );

    const tableRows = branchIds
      .map((branchId) => ({
        key: branchId,
        label: branchNames.get(branchId) ?? branchId,
        enrolments: branchEnrolMap.get(branchId) ?? 0,
        collected: moneyRef(branchCollectionMap.get(branchId) ?? 0),
        activeSchemes: branchActiveMap.get(branchId) ?? 0,
        drilldownPath: `/reports?reportKey=BRANCH_PERFORMANCE&branchId=${branchId}`,
      }))
      .sort((a, b) => b.collected.amountPaise - a.collected.amountPaise);

    const planCollection = collectionMap.get(selectedPlanId) ?? {
      amountPaise: 0,
      count: 0,
    };
    const planEnrolments = enrolmentMap.get(selectedPlanId) ?? 0;
    const planActive = activeMap.get(selectedPlanId) ?? 0;
    const planCommitted = committedByPlan.get(selectedPlanId) ?? 0;

    const statusLabels = {
      ACTIVE: "Active",
      LOCKED: "Locked",
      MATURED: "Matured",
      REDEEMED: "Redeemed",
      DEFAULTED: "Defaulted",
      CLOSED_PREMATURE: "Closed early",
    };

    const { rows, meta } = paginateRows(tableRows, req.query);

    return {
      ...envelopeBase,
      title: `${planLabel} performance`,
      scope: { level: "PLAN", label: planLabel, planId: selectedPlanId },
      summary: [
        {
          key: "ENROLMENTS",
          label: "New enrolments",
          value: planEnrolments,
          valueType: "count",
        },
        {
          key: "COLLECTED",
          label: "Collected",
          value: moneyRef(planCollection.amountPaise),
          valueType: "currency",
        },
        {
          key: "ACTIVE",
          label: "Active schemes",
          value: planActive,
          valueType: "count",
        },
        {
          key: "COMMITTED",
          label: "Committed value",
          value: moneyRef(planCommitted),
          valueType: "currency",
        },
      ],
      charts: {
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
        statusDistribution: {
          chartType: "donut",
          title: "Scheme status",
          yAxis: { type: "count", label: "Schemes" },
          series: [
            {
              key: "status",
              name: "Schemes",
              data: statusCounts.map((row) => ({
                x: statusLabels[row._id] ?? row._id,
                y: row.count,
                yDisplay: String(row.count),
                statusKey: row._id,
              })),
            },
          ],
        },
        collectedByBranch: {
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
      columns: DETAIL_COLUMNS,
      rows,
      meta,
    };
  }

  const planIds = [
    ...new Set([
      ...plans.map((p) => p._id),
      ...enrolmentMap.keys(),
      ...collectionMap.keys(),
    ]),
  ];
  const planNameMap = new Map(plans.map((p) => [p._id, p.name]));

  const tableRows = planIds
    .map((planId) => {
      const collected = collectionMap.get(planId) ?? {
        amountPaise: 0,
        count: 0,
      };
      return {
        key: planId,
        label: planNameMap.get(planId) ?? planId,
        enrolments: enrolmentMap.get(planId) ?? 0,
        collected: moneyRef(collected.amountPaise),
        activeSchemes: activeMap.get(planId) ?? 0,
        paymentCount: collected.count,
        drilldownPath: `/reports?reportKey=SCHEME_PERFORMANCE&planId=${planId}`,
      };
    })
    .sort((a, b) => b.enrolments - a.enrolments || b.collected.amountPaise - a.collected.amountPaise);

  const totalEnrolments = tableRows.reduce((sum, row) => sum + row.enrolments, 0);
  const totalCollected = tableRows.reduce(
    (sum, row) => sum + row.collected.amountPaise,
    0,
  );
  const totalActive = tableRows.reduce(
    (sum, row) => sum + row.activeSchemes,
    0,
  );
  const totalCommitted = [...committedByPlan.values()].reduce(
    (sum, value) => sum + value,
    0,
  );

  const { rows, meta } = paginateRows(tableRows, req.query);

  return {
    ...envelopeBase,
    title: "Scheme performance comparison",
    summary: [
      {
        key: "ENROLMENTS",
        label: "New enrolments",
        value: totalEnrolments,
        valueType: "count",
      },
      {
        key: "COLLECTED",
        label: "Total collected",
        value: moneyRef(totalCollected),
        valueType: "currency",
      },
      {
        key: "ACTIVE",
        label: "Active schemes",
        value: totalActive,
        valueType: "count",
      },
      {
        key: "PLANS",
        label: "Scheme plans",
        value: tableRows.length,
        valueType: "count",
      },
      {
        key: "COMMITTED",
        label: "Committed value",
        value: moneyRef(totalCommitted),
        valueType: "currency",
      },
    ],
    charts: {
      enrolmentsByPlan: {
        chartType: "horizontalBar",
        title: "Enrolments by plan",
        yAxis: { type: "count", label: "Enrolments" },
        series: [
          {
            key: "ENROLMENTS",
            name: "Enrolments",
            data: tableRows.map((row) => ({ x: row.label, y: row.enrolments })),
          },
        ],
      },
      collectionByPlan: {
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
    },
    columns: COMPARISON_COLUMNS,
    rows,
    meta,
  };
}
