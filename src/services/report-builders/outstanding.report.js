import { Customer, Payment, Scheme } from "../../models/index.js";
import { moneyRef } from "../../lib/money.js";
import {
  bucketAsOfYmd,
  formatTrendBucketLabel,
  iteratePeriodBuckets,
} from "../../lib/analytics-period.js";
import {
  ageingBucket,
  baseEnvelope,
  branchNameMap,
  maskMobile,
  paginateRows,
  reportDataScope,
  reportTrendGroupBy,
  schemeInstallmentStats,
} from "./report-envelope.js";

const COLUMNS = [
  { key: "customer", label: "Customer", type: "customer", sticky: true },
  { key: "schemeNumber", label: "Scheme", type: "text" },
  { key: "branch", label: "Showroom", type: "text" },
  { key: "overdueCount", label: "Missed", type: "count", align: "right" },
  { key: "overdueAmount", label: "Overdue", type: "currency", align: "right", emphasis: true },
  { key: "ageingDays", label: "Oldest (days)", type: "count", align: "right", sortable: true },
  { key: "ageingBucket", label: "Bucket", type: "badge" },
  { key: "lastPaymentAt", label: "Last paid", type: "date" },
];

async function aggregatePortfolio(req, asOfYmd) {
  const scope = reportDataScope(req);
  const schemes = await Scheme.find({
    ...scope,
    paymentPattern: "FIXED",
    status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED"] },
    ...(req.query.planId ? { planId: req.query.planId } : {}),
  })
    .select("_id installments")
    .lean();

  let expectedToDate = 0;
  let collectedToDate = 0;
  let futureExpected = 0;
  for (const scheme of schemes) {
    const stats = schemeInstallmentStats(scheme, asOfYmd);
    expectedToDate += stats.expectedToDate;
    collectedToDate += stats.collectedToDate;
    futureExpected += stats.futureExpected;
  }
  const outstanding = Math.max(0, expectedToDate - collectedToDate);
  const efficiency = expectedToDate ? Math.round((collectedToDate / expectedToDate) * 1000) / 10 : 100;
  return { expectedToDate, collectedToDate, outstanding, futureExpected, efficiency };
}

async function efficiencyTrend(req, from, to) {
  const groupBy = reportTrendGroupBy(from, to, req.query);
  const points = [];
  for (const key of iteratePeriodBuckets(from, to, groupBy)) {
    const asOfYmd = bucketAsOfYmd(key, groupBy, to);
    const { efficiency } = await aggregatePortfolio(req, asOfYmd);
    points.push({
      x: key,
      xDisplay: formatTrendBucketLabel(key, groupBy),
      y: efficiency,
      yDisplay: `${efficiency}%`,
    });
  }
  return points;
}

export async function buildOutstandingReport(req) {
  const envelopeBase = baseEnvelope(req, "OUTSTANDING", "Outstanding & ageing");
  const { from, to } = envelopeBase.period;
  const asOfYmd = to ?? from ?? new Date().toISOString().slice(0, 10);

  const scope = reportDataScope(req);
  const overdueSchemes = await Scheme.find({
    ...scope,
    paymentPattern: "FIXED",
    "installments.status": "OVERDUE",
    ...(req.query.planId ? { planId: req.query.planId } : {}),
  })
    .select("_id enrollmentNumber branchId customerId installments")
    .lean();

  const customerIds = [...new Set(overdueSchemes.map((s) => s.customerId))];
  const schemeIds = overdueSchemes.map((s) => s._id);
  const branchIds = [...new Set(overdueSchemes.map((s) => s.branchId).filter(Boolean))];

  const [customers, lastPayments, branchNames, portfolio] = await Promise.all([
    Customer.find({ _id: { $in: customerIds } }).select("_id name mobile passbookNumber").lean(),
    Payment.aggregate([
      { $match: { tenantId: req.auth.tenantId, schemeId: { $in: schemeIds }, status: "SUCCESS" } },
      { $group: { _id: "$schemeId", paidAt: { $max: "$paidAt" } } },
    ]),
    branchNameMap(req.auth.tenantId, branchIds),
    aggregatePortfolio(req, asOfYmd),
  ]);

  const customerMap = new Map(customers.map((c) => [c._id, c]));
  const lastPaidMap = new Map(lastPayments.map((p) => [p._id, p.paidAt]));

  const ageingTotals = { "1–7 days": 0, "8–15 days": 0, "16–30 days": 0, "30+ days": 0 };

  const tableRows = overdueSchemes.map((scheme) => {
    const stats = schemeInstallmentStats(scheme, asOfYmd);
    const bucket = ageingBucket(stats.oldestOverdueDays);
    ageingTotals[bucket.label] = (ageingTotals[bucket.label] ?? 0) + stats.overdueAmount;
    const customer = customerMap.get(scheme.customerId);
    const paidAt = lastPaidMap.get(scheme._id);
    return {
      key: scheme._id,
      customer: customer
        ? {
            id: customer._id,
            name: customer.name,
            mobile: maskMobile(customer.mobile),
            passbookNumber: customer.passbookNumber,
          }
        : { id: scheme.customerId, name: "—" },
      schemeNumber: scheme.enrollmentNumber,
      branch: branchNames.get(scheme.branchId) ?? scheme.branchId ?? "—",
      overdueCount: stats.overdueCount,
      overdueAmount: moneyRef(stats.overdueAmount),
      ageingDays: stats.oldestOverdueDays,
      ageingBucket: bucket,
      lastPaymentAt: paidAt ? paidAt.toISOString().slice(0, 10) : null,
      drilldownPath: `/schemes/${scheme._id}`,
    };
  });

  tableRows.sort((a, b) => b.overdueAmount.amountPaise - a.overdueAmount.amountPaise);

  const envelope = {
    ...envelopeBase,
    summary: [
      { key: "EXPECTED_TO_DATE", label: "Expected to date", value: moneyRef(portfolio.expectedToDate), valueType: "currency" },
      { key: "COLLECTED_TO_DATE", label: "Collected to date", value: moneyRef(portfolio.collectedToDate), valueType: "currency" },
      {
        key: "OUTSTANDING",
        label: "Outstanding",
        value: moneyRef(portfolio.outstanding),
        valueType: "currency",
        severity: portfolio.outstanding > 0 ? "WARNING" : undefined,
      },
      { key: "COLLECTION_EFFICIENCY", label: "Collection efficiency", value: portfolio.efficiency, valueType: "percent" },
      { key: "FUTURE_EXPECTED", label: "Future installments", value: moneyRef(portfolio.futureExpected), valueType: "currency" },
    ],
    charts: {
      ageing: {
        chartType: "bar",
        title: "Outstanding by ageing",
        yAxis: { type: "currency", label: "Amount" },
        series: [
          {
            key: "OUTSTANDING",
            name: "Outstanding",
            data: Object.entries(ageingTotals).map(([x, amountPaise]) => ({
              x,
              y: amountPaise,
              yDisplay: moneyRef(amountPaise).amountDisplay,
            })),
          },
        ],
      },
      efficiencyTrend: {
        chartType: "line",
        title: "Collection efficiency",
        subtitle: `Grouped by ${reportTrendGroupBy(from, to, req.query).toLowerCase()}`,
        yAxis: { type: "percent", label: "Efficiency", min: 0, max: 100 },
        series: [
          {
            key: "EFFICIENCY",
            name: "Efficiency",
            data: await efficiencyTrend(req, from, to),
          },
        ],
      },
    },
    columns: COLUMNS,
  };

  const { rows, meta } = paginateRows(tableRows, req.query);
  return { ...envelope, rows, meta };
}
