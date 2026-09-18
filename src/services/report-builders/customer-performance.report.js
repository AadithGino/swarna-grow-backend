import { Customer, Payment, Scheme } from "../../models/index.js";
import { moneyRef } from "../../lib/money.js";
import { dateMatch } from "../../lib/query-filters.js";
import {
  baseEnvelope,
  buildCountTrendPoints,
  buildCurrencyTrendPoints,
  paginateRows,
  reportDataScope,
  reportTrendGroupBy,
} from "./report-envelope.js";
import { buildCustomerLedgerDetail } from "./customer-ledger.report.js";

const COMPARISON_COLUMNS = [
  { key: "label", label: "Customer", type: "text", sticky: true, sortable: true },
  { key: "collected", label: "Collected", type: "currency", align: "right", emphasis: true, sortable: true },
  { key: "enrolments", label: "Enrolments", type: "count", align: "right", sortable: true },
  { key: "activeSchemes", label: "Active schemes", type: "count", align: "right" },
  { key: "paymentCount", label: "Payments", type: "count", align: "right" },
];

function mergeCustomerMetrics(customers, collectionMap, enrolmentMap, activeMap) {
  return customers.map((customer) => {
    const collected = collectionMap.get(customer._id) ?? {
      amountPaise: 0,
      count: 0,
    };
    return {
      key: customer._id,
      label: `${customer.name} · ${customer.customerNumber}`,
      collected: moneyRef(collected.amountPaise),
      enrolments: enrolmentMap.get(customer._id) ?? 0,
      activeSchemes: activeMap.get(customer._id) ?? 0,
      paymentCount: collected.count,
      drilldownPath: `/reports?reportKey=CUSTOMER_PERFORMANCE&customerId=${customer._id}`,
    };
  });
}

export async function buildCustomerPerformanceReport(req) {
  const selectedCustomerId = req.query.customerId
    ? String(req.query.customerId)
    : null;

  if (selectedCustomerId) {
    return buildCustomerLedgerDetail(req, {
      reportKey: "CUSTOMER_PERFORMANCE",
      titlePrefix: "Customer ledger",
    });
  }

  const envelopeBase = baseEnvelope(
    req,
    "CUSTOMER_PERFORMANCE",
    "Customer performance",
  );
  const { from, to } = envelopeBase.period;
  const tenantId = req.auth.tenantId;
  const scope = reportDataScope(req);
  const groupBy = reportTrendGroupBy(from, to, req.query);
  const customerScope = scope.branchId
    ? { tenantId, branchId: scope.branchId }
    : { tenantId };

  const [
    byCustomerCollection,
    byCustomerEnrolments,
    byCustomerActive,
    dailyRegistrations,
    dailyCollection,
    totalCustomers,
    newCustomers,
  ] = await Promise.all([
    Payment.aggregate([
      {
        $match: {
          ...customerScope,
          status: "SUCCESS",
          ...dateMatch("paidAt", { from, to }),
        },
      },
      {
        $group: {
          _id: "$customerId",
          amountPaise: { $sum: "$amountPaise" },
          count: { $sum: 1 },
        },
      },
    ]),
    Scheme.aggregate([
      {
        $match: {
          ...customerScope,
          ...dateMatch("createdAt", { from, to }),
        },
      },
      { $group: { _id: "$customerId", count: { $sum: 1 } } },
    ]),
    Scheme.aggregate([
      {
        $match: {
          ...customerScope,
          status: { $in: ["ACTIVE", "LOCKED"] },
        },
      },
      { $group: { _id: "$customerId", count: { $sum: 1 } } },
    ]),
    Customer.aggregate([
      {
        $match: {
          ...customerScope,
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
          ...customerScope,
          status: "SUCCESS",
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
          amountPaise: { $sum: "$amountPaise" },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Customer.countDocuments(customerScope),
    Customer.countDocuments({
      ...customerScope,
      ...dateMatch("createdAt", { from, to }),
    }),
  ]);

  const collectionMap = new Map(byCustomerCollection.map((r) => [r._id, r]));
  const enrolmentMap = new Map(
    byCustomerEnrolments.map((r) => [r._id, r.count]),
  );
  const activeMap = new Map(byCustomerActive.map((r) => [r._id, r.count]));

  const customerIds = [
    ...new Set([
      ...byCustomerCollection.map((r) => r._id).filter(Boolean),
      ...byCustomerEnrolments.map((r) => r._id).filter(Boolean),
      ...byCustomerActive.map((r) => r._id).filter(Boolean),
    ]),
  ];

  const customers = customerIds.length
    ? await Customer.find({ _id: { $in: customerIds }, ...customerScope })
        .select("_id name customerNumber")
        .sort({ name: 1 })
        .lean()
    : [];

  const tableRows = mergeCustomerMetrics(
    customers,
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
  const totalPayments = tableRows.reduce(
    (sum, row) => sum + row.paymentCount,
    0,
  );
  const activeCustomers = byCustomerActive.length;

  const { rows, meta } = paginateRows(tableRows, req.query);

  return {
    ...envelopeBase,
    title: "Customer performance overview",
    summary: [
      {
        key: "TOTAL_CUSTOMERS",
        label: "Total customers",
        value: totalCustomers,
        valueType: "count",
      },
      {
        key: "NEW_CUSTOMERS",
        label: "New registrations",
        value: newCustomers,
        valueType: "count",
      },
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
        key: "ACTIVE_CUSTOMERS",
        label: "Customers with active schemes",
        value: activeCustomers,
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
      collectionByCustomer: {
        chartType: "horizontalBar",
        title: "Collection by customer",
        yAxis: { type: "currency", label: "Amount" },
        series: [
          {
            key: "COLLECTED",
            name: "Collected",
            data: tableRows.slice(0, 12).map((row) => ({
              x: row.label,
              y: row.collected.amountPaise,
              yDisplay: row.collected.amountDisplay,
            })),
          },
        ],
      },
      registrationTrend: {
        chartType: "line",
        title: "New customer registrations",
        subtitle: `Grouped by ${groupBy.toLowerCase()}`,
        yAxis: { type: "count", label: "Customers" },
        series: [
          {
            key: "REGISTRATIONS",
            name: "Registrations",
            data: buildCountTrendPoints(
              dailyRegistrations.map((row) => ({
                _id: row._id,
                count: row.count,
              })),
              from,
              to,
              groupBy,
            ),
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
              dailyCollection.map((row) => ({
                _id: row._id,
                amountPaise: row.amountPaise,
              })),
              from,
              to,
              groupBy,
            ),
          },
        ],
      },
    },
    columns: COMPARISON_COLUMNS,
    rows,
    meta,
  };
}
