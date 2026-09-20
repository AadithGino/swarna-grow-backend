import { Customer, Scheme } from "../../models/index.js";
import { moneyRef } from "../../lib/money.js";
import { forEachSchemeBatch } from "../../lib/scheme-batch-loader.js";
import { recoveryTotalsByBranch, sumPaidTotalFromSchemes } from "../../lib/scheme-portfolio-stats.js";
import { paginate } from "../../lib/pagination.js";
import {
  baseEnvelope,
  branchNameMap,
  maskMobile,
  reportDataScope,
  schemeInstallmentStats,
} from "./report-envelope.js";

const COLUMNS = [
  { key: "customer", label: "Customer", type: "customer", sticky: true },
  { key: "schemeNumber", label: "Scheme", type: "text" },
  { key: "branch", label: "Showroom", type: "text" },
  { key: "defaultedAt", label: "Defaulted", type: "date" },
  { key: "recoveryValue", label: "Recovery value", type: "currency", align: "right", emphasis: true },
];

async function loadAllDefaultedSchemes(scope, planId) {
  const schemes = [];
  await forEachSchemeBatch({
    model: Scheme,
    filter: {
      ...scope,
      status: "DEFAULTED",
      paymentPattern: "FIXED",
      ...(planId ? { planId } : {}),
    },
    projection: "_id branchId installments",
    handler: (rows) => {
      schemes.push(...rows);
    },
  });
  return schemes;
}

export async function buildDefaulterReport(req) {
  const envelope = baseEnvelope(req, "DEFAULTER", "Defaulter report");
  const asOfYmd = envelope.period.to ?? envelope.period.from ?? new Date().toISOString().slice(0, 10);

  const scope = reportDataScope(req);
  const planId = req.query.planId;
  const page = await paginate(Scheme, {
    scope,
    filters: {
      status: "DEFAULTED",
      paymentPattern: "FIXED",
      ...(planId ? { planId } : {}),
    },
    cursor: req.query.cursor,
    limit: req.query.limit ?? 50,
    sort: "updatedAt:desc",
    projection: "_id enrollmentNumber branchId customerId installments updatedAt",
  });

  const customerIds = [...new Set(page.data.map((s) => s.customerId))];
  const branchIds = [...new Set(page.data.map((s) => s.branchId).filter(Boolean))];

  const defaulterFilter = {
    ...scope,
    status: "DEFAULTED",
    paymentPattern: "FIXED",
    ...(planId ? { planId } : {}),
  };

  const [customers, branchNames, branchRecovery, allDefaulted] =
    await Promise.all([
      Customer.find({ _id: { $in: customerIds } })
        .select("_id name mobile")
        .lean(),
      branchNameMap(req.auth.tenantId, branchIds),
      Scheme.aggregate([
        { $match: defaulterFilter },
        { $group: { _id: "$branchId", count: { $sum: 1 } } },
      ]),
      loadAllDefaultedSchemes(scope, planId),
    ]);

  const customerMap = new Map(customers.map((c) => [c._id, c]));
  const totalRecovery = sumPaidTotalFromSchemes(allDefaulted, asOfYmd);
  const recoveryByBranchMap = recoveryTotalsByBranch(allDefaulted, asOfYmd);

  const rows = page.data.map((scheme) => {
    const stats = schemeInstallmentStats(scheme, asOfYmd);
    const recoveryValue = stats.paidTotal;
    const customer = customerMap.get(scheme.customerId);
    return {
      key: scheme._id,
      customer: customer
        ? { id: customer._id, name: customer.name, mobile: maskMobile(customer.mobile) }
        : { name: "—" },
      schemeNumber: scheme.enrollmentNumber,
      branch: branchNames.get(scheme.branchId) ?? "—",
      defaultedAt: scheme.updatedAt ? new Date(scheme.updatedAt).toISOString().slice(0, 10) : null,
      recoveryValue: moneyRef(recoveryValue),
      drilldownPath: `/schemes/${scheme._id}`,
    };
  });

  const branchNameLookup = await branchNameMap(
    req.auth.tenantId,
    [...recoveryByBranchMap.keys()].filter((id) => id !== "__none__"),
  );
  const recoveryByBranch = [...recoveryByBranchMap.entries()].map(([branchKey, recovery]) => {
    const name = branchKey === "__none__"
      ? "—"
      : branchNameLookup.get(branchKey) ?? branchKey;
    return { x: name, y: recovery, yDisplay: moneyRef(recovery).amountDisplay };
  });

  const defaulterCount = branchRecovery.reduce((sum, row) => sum + row.count, 0);

  return {
    ...envelope,
    summary: [
      { key: "DEFAULTERS", label: "Defaulted schemes", value: defaulterCount, valueType: "count" },
      { key: "RECOVERY", label: "Recovery value", value: moneyRef(totalRecovery), valueType: "currency" },
      {
        key: "WRITTEN_OFF",
        label: "At risk",
        value: moneyRef(0),
        valueType: "currency",
        severity: defaulterCount > 0 ? "WARNING" : undefined,
      },
    ],
    charts: {
      recoveryByBranch: {
        chartType: "horizontalBar",
        title: "Recovery by showroom",
        yAxis: { type: "currency", label: "Amount" },
        series: [{ key: "RECOVERY", name: "Recovery", data: recoveryByBranch }],
      },
    },
    columns: COLUMNS,
    rows,
    meta: page.meta,
  };
}
