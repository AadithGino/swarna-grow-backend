import { Customer, LedgerEntry, Scheme } from "../../models/index.js";
import { moneyRef, weightRef } from "../../lib/money.js";
import { forEachSchemeBatch } from "../../lib/scheme-batch-loader.js";
import { paginate } from "../../lib/pagination.js";
import {
  baseEnvelope,
  reportDataScope,
  schemeInstallmentStats,
  statusBadge,
} from "./report-envelope.js";

const COLUMNS = [
  { key: "schemeNumber", label: "Scheme", type: "text", sticky: true },
  { key: "customer", label: "Customer", type: "customer" },
  { key: "plan", label: "Plan", type: "text" },
  { key: "status", label: "Status", type: "badge" },
  { key: "paid", label: "Paid", type: "currency", align: "right" },
  { key: "outstanding", label: "Outstanding", type: "currency", align: "right" },
  { key: "grams", label: "Grams", type: "weight", align: "right" },
];

const STATUS_LABELS = {
  ACTIVE: "Active",
  LOCKED: "Locked",
  MATURED: "Matured",
  REDEEMED: "Redeemed",
  DEFAULTED: "Defaulted",
  CLOSED_PREMATURE: "Closed early",
};

async function summarizePortfolioBatched(scope, filters, asOfYmd, tenantId) {
  let portfolioOutstanding = 0;
  let activeCount = 0;
  await forEachSchemeBatch({
    model: Scheme,
    filter: { ...scope, ...filters },
    projection: "_id status installments",
    handler: (rows) => {
      for (const scheme of rows) {
        const stats = schemeInstallmentStats(scheme, asOfYmd);
        const paid = stats.paidTotal;
        portfolioOutstanding +=
          stats.overdueAmount + Math.max(0, stats.expectedToDate - paid);
        if (["ACTIVE", "LOCKED"].includes(scheme.status)) activeCount += 1;
      }
    },
  });

  const ledgerPipeline = [
    { $match: { tenantId, weightMg: { $gt: 0 } } },
  ];
  if (scope.branchId) {
    ledgerPipeline.push(
      {
        $lookup: {
          from: "schemes",
          localField: "schemeId",
          foreignField: "_id",
          as: "scheme",
        },
      },
      { $unwind: "$scheme" },
      { $match: { "scheme.branchId": scope.branchId, ...(filters.planId ? { "scheme.planId": filters.planId } : {}) } },
    );
  } else if (filters.planId) {
    ledgerPipeline.push(
      {
        $lookup: {
          from: "schemes",
          localField: "schemeId",
          foreignField: "_id",
          as: "scheme",
        },
      },
      { $unwind: "$scheme" },
      { $match: { "scheme.planId": filters.planId } },
    );
  }
  ledgerPipeline.push({ $group: { _id: null, weightMg: { $sum: "$weightMg" } } });
  const [gramsRow] = await LedgerEntry.aggregate(ledgerPipeline);

  return {
    portfolioOutstanding,
    portfolioGrams: gramsRow?.weightMg ?? 0,
    activeCount,
  };
}

export async function buildSchemeRegisterReport(req) {
  const envelope = baseEnvelope(req, "SCHEME_REGISTER", "Scheme register");
  const asOfYmd =
    envelope.period.to ??
    envelope.period.from ??
    new Date().toISOString().slice(0, 10);

  const scope = reportDataScope(req);
  const filters = {
    ...(req.query.planId ? { planId: req.query.planId } : {}),
  };

  const [page, statusCounts, portfolioTotals, totalSchemes] = await Promise.all([
    paginate(Scheme, {
      scope,
      filters,
      cursor: req.query.cursor,
      limit: req.query.limit ?? 50,
      sort: "createdAt:desc",
      projection:
        "_id enrollmentNumber customerId planId planSnapshot status installments",
    }),
    Scheme.aggregate([
      { $match: { ...scope, ...filters } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    summarizePortfolioBatched(scope, filters, asOfYmd, req.auth.tenantId),
    Scheme.countDocuments({ ...scope, ...filters }),
  ]);

  const pageSchemeIds = page.data.map((s) => s._id);
  const customerIds = [...new Set(page.data.map((s) => s.customerId))];

  const [customers, pageWeights] = await Promise.all([
    Customer.find({ _id: { $in: customerIds } }).select("_id name").lean(),
    pageSchemeIds.length
      ? LedgerEntry.aggregate([
        {
          $match: {
            tenantId: req.auth.tenantId,
            schemeId: { $in: pageSchemeIds },
            weightMg: { $gt: 0 },
          },
        },
        { $group: { _id: "$schemeId", weightMg: { $sum: "$weightMg" } } },
      ])
      : [],
  ]);

  const customerMap = new Map(customers.map((c) => [c._id, c]));
  const pageWeightMap = new Map(pageWeights.map((w) => [w._id, w.weightMg]));
  const { portfolioOutstanding, portfolioGrams, activeCount } = portfolioTotals;

  const rows = page.data.map((scheme) => {
    const stats = schemeInstallmentStats(scheme, asOfYmd);
    const paid = stats.paidTotal;
    const outstanding = Math.max(
      0,
      stats.expectedToDate + stats.futureExpected - paid,
    );
    const grams = pageWeightMap.get(scheme._id) ?? 0;
    const customer = customerMap.get(scheme.customerId);
    return {
      key: scheme._id,
      schemeNumber: scheme.enrollmentNumber,
      customer: customer
        ? { id: customer._id, name: customer.name }
        : { name: "—" },
      plan: scheme.planSnapshot?.name ?? scheme.planId,
      status: statusBadge(scheme.status),
      paid: moneyRef(paid),
      outstanding: moneyRef(outstanding),
      grams: weightRef(grams),
      drilldownPath: `/schemes/${scheme._id}`,
    };
  });

  return {
    ...envelope,
    summary: [
      {
        key: "ACTIVE",
        label: "Active schemes",
        value: activeCount,
        valueType: "count",
      },
      {
        key: "OUTSTANDING",
        label: "Outstanding",
        value: moneyRef(portfolioOutstanding),
        valueType: "currency",
      },
      {
        key: "GRAMS",
        label: "Gold accrued",
        value: weightRef(portfolioGrams),
        valueType: "weight",
      },
    ],
    charts: {
      statusDistribution: {
        chartType: "donut",
        title: "By status",
        yAxis: { type: "count", label: "Schemes" },
        series: [
          {
            key: "status",
            name: "Schemes",
            data: statusCounts.map((row) => ({
              x: STATUS_LABELS[row._id] ?? row._id,
              y: row.count,
              yDisplay: String(row.count),
              statusKey: row._id,
            })),
          },
        ],
      },
    },
    columns: COLUMNS,
    rows,
    meta: {
      ...page.meta,
      total: totalSchemes,
    },
  };
}
