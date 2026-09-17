import { Customer, LedgerEntry, Scheme } from "../../models/index.js";
import { moneyRef, weightRef } from "../../lib/money.js";
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

function summarizePortfolio(schemes, weightMap, asOfYmd) {
  let portfolioOutstanding = 0;
  let portfolioGrams = 0;
  let activeCount = 0;

  for (const scheme of schemes) {
    const stats = schemeInstallmentStats(scheme, asOfYmd);
    const paid = stats.paidTotal;
    portfolioOutstanding +=
      stats.overdueAmount + Math.max(0, stats.expectedToDate - paid);
    portfolioGrams += weightMap.get(scheme._id) ?? 0;
    if (["ACTIVE", "LOCKED"].includes(scheme.status)) activeCount += 1;
  }

  return { portfolioOutstanding, portfolioGrams, activeCount };
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

  const [page, portfolioSchemes, statusCounts] = await Promise.all([
    paginate(Scheme, {
      scope,
      filters,
      cursor: req.query.cursor,
      limit: req.query.limit ?? 50,
      sort: "createdAt:desc",
      projection:
        "_id enrollmentNumber customerId planId planSnapshot status installments",
    }),
    Scheme.find({ ...scope, ...filters })
      .select("_id status installments")
      .lean(),
    Scheme.aggregate([
      { $match: { ...scope, ...filters } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  const portfolioSchemeIds = portfolioSchemes.map((s) => s._id);
  const pageSchemeIds = page.data.map((s) => s._id);
  const customerIds = [...new Set(page.data.map((s) => s.customerId))];

  const [customers, pageWeights, portfolioWeights] = await Promise.all([
    Customer.find({ _id: { $in: customerIds } }).select("_id name").lean(),
    LedgerEntry.aggregate([
      {
        $match: {
          tenantId: req.auth.tenantId,
          schemeId: { $in: pageSchemeIds },
          weightMg: { $gt: 0 },
        },
      },
      { $group: { _id: "$schemeId", weightMg: { $sum: "$weightMg" } } },
    ]),
    LedgerEntry.aggregate([
      {
        $match: {
          tenantId: req.auth.tenantId,
          schemeId: { $in: portfolioSchemeIds },
          weightMg: { $gt: 0 },
        },
      },
      { $group: { _id: "$schemeId", weightMg: { $sum: "$weightMg" } } },
    ]),
  ]);

  const customerMap = new Map(customers.map((c) => [c._id, c]));
  const pageWeightMap = new Map(pageWeights.map((w) => [w._id, w.weightMg]));
  const portfolioWeightMap = new Map(
    portfolioWeights.map((w) => [w._id, w.weightMg]),
  );
  const { portfolioOutstanding, portfolioGrams, activeCount } =
    summarizePortfolio(portfolioSchemes, portfolioWeightMap, asOfYmd);

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
      total: portfolioSchemes.length,
    },
  };
}
