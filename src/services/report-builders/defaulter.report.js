import { Customer, Scheme } from "../../models/index.js";
import { moneyRef } from "../../lib/money.js";
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

export async function buildDefaulterReport(req) {
  const envelope = baseEnvelope(req, "DEFAULTER", "Defaulter report");
  const asOfYmd = envelope.period.to ?? envelope.period.from ?? new Date().toISOString().slice(0, 10);

  const scope = reportDataScope(req);
  const page = await paginate(Scheme, {
    scope,
    filters: {
      status: "DEFAULTED",
      paymentPattern: "FIXED",
      ...(req.query.planId ? { planId: req.query.planId } : {}),
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
    ...(req.query.planId ? { planId: req.query.planId } : {}),
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
      Scheme.find(defaulterFilter).select("installments").lean(),
    ]);

  const customerMap = new Map(customers.map((c) => [c._id, c]));
  const totalRecovery = allDefaulted.reduce(
    (sum, scheme) =>
      sum + schemeInstallmentStats(scheme, asOfYmd).paidTotal,
    0,
  );

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

  const recoveryByBranch = await Promise.all(
    branchRecovery.map(async (row) => {
      const schemes = await Scheme.find({
        ...scope,
        status: "DEFAULTED",
        branchId: row._id,
      })
        .select("installments")
        .lean();
      let recovery = 0;
      for (const scheme of schemes) {
        recovery += schemeInstallmentStats(scheme, asOfYmd).paidTotal;
      }
      const name = (await branchNameMap(req.auth.tenantId, [row._id])).get(row._id) ?? row._id;
      return { x: name, y: recovery, yDisplay: moneyRef(recovery).amountDisplay };
    }),
  );

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
