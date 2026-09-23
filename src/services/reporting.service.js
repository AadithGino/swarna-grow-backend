import {
  CashHandover,
  Customer,
  ExportJob,
  LedgerEntry,
  Message,
  Payment,
  Redemption,
  Scheme,
} from "../models/index.js";
import { ExportStatus, ExportType, RedemptionStatus, isEnumValue } from "../constants/enums.js";
import { storageProvider } from "../integrations/storage.provider.js";
import { errors } from "../lib/app-error.js";
import { PAYMENT_MODE_ORDER, PAYMENT_MODE_LABELS } from "../constants/enums.js";
import { createId } from "../lib/ids.js";
import { getQueue } from "../queues/index.js";
import { AppError } from "../lib/app-error.js";
import { listAuditEvents } from "./audit.service.js";
import {
  ACTIVE_AND_LOCKED_STATUSES,
  OPEN_ENROLLMENT_STATUSES,
} from "../lib/scheme-enrollment-status.js";
import { collectionSummary } from "./collection-summary.js";
import { buildAdminReport } from "./report-builders/index.js";
import {
  dateMatch,
  effectiveScope,
  resolveQueryDateRange,
} from "../lib/query-filters.js";
import { Branch } from "../models/index.js";
import { redemptionPeriodSummary } from "./redemption-period-summary.js";
import { moneyRef, weightRef } from "../lib/money.js";
import {
  buildCountTrendPoints,
  buildCurrencyTrendPoints,
  reportTrendGroupBy,
} from "./report-builders/report-envelope.js";
import {
  assertExportJobAccessible,
  exportJobListQuery,
  resolveExportScopeSnapshot,
  sanitizedExportFilters,
} from "../lib/export-authority.js";
import {
  netCollectionStatusFilter,
  sumNetAmountPaise,
} from "../lib/payment-net-aggregation.js";

export { collectionSummary };

const OPEN_REDEMPTION_STATUSES = [
  RedemptionStatus.REQUESTED,
  RedemptionStatus.PENDING_APPROVAL,
  RedemptionStatus.APPROVED,
];

export async function navBadges(req) {
  const { effectiveScope } = await import("../lib/query-filters.js");
  const { messageBranchScope } = await import("./messaging.service.js");
  const scope = effectiveScope(req);
  const messageScope = await messageBranchScope(req);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const [dues, cashHandovers, openRedemptions, failedMessages] =
    await Promise.all([
      Scheme.countDocuments({
        ...scope,
        paymentPattern: "FIXED",
        "installments.status": { $in: ["DUE", "PARTIALLY_PAID"] },
      }),
      CashHandover.countDocuments({ ...scope, status: "PENDING" }),
      Redemption.countDocuments({
        ...scope,
        status: { $in: OPEN_REDEMPTION_STATUSES },
      }),
      Message.countDocuments({
        ...messageScope,
        status: "FAILED",
        createdAt: { $gte: monthStart },
      }),
    ]);
  return { dues, cashHandovers, openRedemptions, failedMessages };
}

const fillModes = (rows) =>
  PAYMENT_MODE_ORDER.filter((mode) => mode !== "LEGACY_ONLINE" || rows.some((row) => row._id === mode)).map((mode) => {
    const row = rows.find((item) => item._id === mode);
    return { mode, label: PAYMENT_MODE_LABELS[mode], amountPaise: row?.amountPaise ?? 0, count: row?.count ?? 0 };
  });
async function scopeDisplayLabel(scope) {
  if (!scope.branchId) return "All showrooms";
  const branch = await Branch.findOne({
    _id: scope.branchId,
    tenantId: scope.tenantId,
  })
    .select("name code")
    .lean();
  return branch?.name ?? branch?.code ?? "Branch";
}

export async function dashboard(req) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const scope = effectiveScope(req);
  const period = String(req.query.period ?? "THIS_MONTH");
  const periodLabels = { TODAY: "Today", THIS_WEEK: "This week", THIS_MONTH: "This month", LAST_MONTH: "Last month" };
  const periodRange = resolveQueryDateRange(req.query);
  const [
    todayPayments,
    activeCustomers,
    openSchemes,
    activeAndLockedSchemes,
    overdue,
    maturities,
    handovers,
    grievances,
    openRedemptions,
    redemptions,
  ] = await Promise.all([
    Payment.aggregate([
      { $match: { ...scope, ...netCollectionStatusFilter(), paidAt: { $gte: start } } },
      { $group: { _id: "$mode", amountPaise: sumNetAmountPaise(), count: { $sum: 1 } } },
    ]),
    Customer.countDocuments({ ...scope, status: "ACTIVE" }),
    Scheme.countDocuments({ ...scope, status: { $in: OPEN_ENROLLMENT_STATUSES } }),
    Scheme.countDocuments({ ...scope, status: { $in: ACTIVE_AND_LOCKED_STATUSES } }),
    Scheme.countDocuments({ ...scope, "installments.status": "OVERDUE" }), Scheme.countDocuments({ ...scope, status: "MATURED" }), CashHandover.countDocuments({ ...scope, status: "PENDING" }),
    (await import("../models/index.js")).Grievance.countDocuments({ ...scope, status: { $in: ["OPEN", "IN_PROGRESS"] } }),
    Redemption.countDocuments({ ...scope, status: { $in: OPEN_REDEMPTION_STATUSES } }),
    redemptionPeriodSummary(scope, periodRange),
  ]);
  const todayCount = todayPayments.reduce((sum, row) => sum + row.count, 0);
  const todayAmount = todayPayments.reduce((sum, row) => sum + row.amountPaise, 0);
  return {
    today: { amountPaise: todayAmount, count: todayCount, byMode: fillModes(todayPayments) },
    customers: { active: activeCustomers },
    schemes: {
      open: openSchemes,
      activeAndLocked: activeAndLockedSchemes,
      /** @deprecated use schemes.open */
      active: openSchemes,
      overdue,
      matured: maturities,
    },
    attention: { pendingCashHandovers: handovers, openGrievances: grievances, openRedemptions },
    redemptions,
    defaultCharts: ["collection-trend", "collection-by-mode", "scheme-status-distribution"],
    scope: {
      level: scope.branchId ? "BRANCH" : "TENANT",
      label: await scopeDisplayLabel(scope),
      branchId: scope.branchId ?? null,
    },
    period: {
      key: period,
      label: periodLabels[period] ?? "This month",
      from: periodRange.from ?? req.query.from,
      to: periodRange.to ?? req.query.to,
    },
  };
}
function chartDateRange(req) {
  return resolveQueryDateRange(req.query);
}

async function collectionTrendChart(req, scope) {
  const range = chartDateRange(req);
  const buckets = await Payment.aggregate([
    {
      $match: {
        ...scope,
        ...netCollectionStatusFilter(),
        ...dateMatch("paidAt", range),
      },
    },
    {
      $group: {
        _id: {
          day: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$paidAt",
              timezone: "Asia/Kolkata",
            },
          },
          bucket: {
            $cond: [{ $eq: ["$mode", "CASH"] }, "CASH", "DIGITAL"],
          },
        },
        value: sumNetAmountPaise(),
      },
    },
    { $sort: { "_id.day": 1 } },
  ]);
  const byDay = new Map();
  for (const row of buckets) {
    const day = row._id.day;
    const entry = byDay.get(day) ?? { CASH: 0, DIGITAL: 0 };
    entry[row._id.bucket] = row.value;
    byDay.set(day, entry);
  }
  const { from, to } = range;
  const groupBy = reportTrendGroupBy(from, to, req.query);
  const cashRows = [...byDay.entries()].map(([day, entry]) => ({
    _id: day,
    amountPaise: entry.CASH ?? 0,
  }));
  const digitalRows = [...byDay.entries()].map(([day, entry]) => ({
    _id: day,
    amountPaise: entry.DIGITAL ?? 0,
  }));
  return {
    chartType: "line",
    title: "Collection trend",
    subtitle: from && to ? `Grouped by ${groupBy.toLowerCase()}` : undefined,
    yAxis: { type: "currency", label: "Amount" },
    series: [
      {
        key: "CASH",
        name: "Cash",
        data:
          from && to
            ? buildCurrencyTrendPoints(cashRows, from, to, groupBy)
            : cashRows.map((row) => ({
                x: row._id,
                y: row.amountPaise,
                yDisplay: moneyRef(row.amountPaise).amountDisplay,
              })),
      },
      {
        key: "DIGITAL",
        name: "Digital",
        data:
          from && to
            ? buildCurrencyTrendPoints(digitalRows, from, to, groupBy)
            : digitalRows.map((row) => ({
                x: row._id,
                y: row.amountPaise,
                yDisplay: moneyRef(row.amountPaise).amountDisplay,
              })),
      },
    ],
  };
}

export async function chart(req, key) {
  const scope = effectiveScope(req);
  const range = chartDateRange(req);
  if (key === "collection-trend") return collectionTrendChart(req, scope);
  if (key === "scheme-status-distribution") {
    return Scheme.aggregate([
      {
        $match: {
          ...scope,
          status: {
            $in: [
              "ACTIVE",
              "LOCKED",
              "DEFAULTED",
              "MATURED",
              "REDEEMED",
              "CLOSED_PREMATURE",
            ],
          },
        },
      },
      { $group: { _id: "$status", value: { $sum: 1 } } },
      { $project: { _id: 0, key: "$_id", label: "$_id", value: 1 } },
    ]);
  }
  if (key === "gold-accrual-trend") {
    const dailyRows = await LedgerEntry.aggregate([
      {
        $match: {
          ...scope,
          weightMg: { $gt: 0 },
          ...dateMatch("effectiveAt", range),
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$effectiveAt",
              timezone: "Asia/Kolkata",
            },
          },
          count: { $sum: "$weightMg" },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    const { from, to } = range;
    const groupBy = reportTrendGroupBy(from, to, req.query);
    const trend =
      from && to
        ? buildCountTrendPoints(dailyRows, from, to, groupBy).map((point) => ({
            ...point,
            yDisplay: weightRef(point.y).weightDisplay,
          }))
        : dailyRows.map((row) => ({
            x: row._id,
            y: row.count,
            yDisplay: weightRef(row.count).weightDisplay,
          }));
    return {
      chartType: "line",
      title: "Gold accrual",
      subtitle: from && to ? `Grouped by ${groupBy.toLowerCase()}` : undefined,
      yAxis: { type: "weight", label: "Weight" },
      series: [{ key: "GOLD", name: "Gold", data: trend }],
    };
  }
  const group = key === "collection-by-branch" ? "$branchId" : key === "collection-by-mode" ? "$mode" : { $dateToString: { format: "%Y-%m-%d", date: "$paidAt", timezone: "Asia/Kolkata" } };
  return Payment.aggregate([
    { $match: { ...scope, ...netCollectionStatusFilter(), ...dateMatch("paidAt", range) } },
    { $group: { _id: group, value: sumNetAmountPaise(), count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, key: "$_id", label: "$_id", value: 1, count: 1 } },
  ]);
}
export async function report(req, reportKey) {
  const built = await buildAdminReport(req, reportKey);
  if (built) return built;
  throw new AppError("REPORT_UNKNOWN", `Unknown report key: ${reportKey}`, 404);
}
export function toExportJobDto(job) {
  if (!job) return null;
  const exportId = job._id;
  const format = job.filters?.format ?? "CSV";
  const dto = {
    ...job,
    exportId,
    reportKey: job.type,
    format,
    statusUrl: `/api/v1/admin/exports/${exportId}`,
  };
  if (job.status === ExportStatus.READY && job.objectKey) {
    const fileUrl = `/api/v1/admin/exports/${exportId}/file`;
    dto.url = fileUrl;
    dto.downloadUrl = fileUrl;
    if (job.downloadExpiresAt) dto.expiresAt = job.downloadExpiresAt;
  }
  return dto;
}

export async function createExport(req) {
  const exportType = req.body.type;
  if (!isEnumValue(ExportType, exportType)) {
    throw new AppError(
      "EXPORT_TYPE_INVALID",
      `Unsupported export type: ${exportType}`,
      422,
      { supported: Object.values(ExportType) },
    );
  }
  const format = req.body.format ?? "CSV";
  if (!["CSV", "PDF"].includes(format)) {
    throw new AppError(
      "EXPORT_FORMAT_NOT_SUPPORTED",
      `Export format ${format} is not supported.`,
      422,
      { supported: ["CSV", "PDF"] },
    );
  }
  const { from, to } = req.body.filters ?? {};
  if (from && to) {
    const rangeMs = new Date(`${to}T23:59:59Z`) - new Date(`${from}T00:00:00Z`);
    if (rangeMs < 0 || rangeMs > 5 * 366 * 86_400_000) {
      throw new AppError("EXPORT_RANGE_TOO_LARGE", "Export date range cannot exceed five years.", 422);
    }
  }
  const { assertExportConcurrency } = await import("../lib/report-limits.js");
  await assertExportConcurrency(req.auth.tenantId);
  const scopeSnapshot = resolveExportScopeSnapshot(req);
  const job = await ExportJob.create({
    _id: createId("export"),
    tenantId: req.auth.tenantId,
    requestedBy: req.auth.id,
    type: exportType,
    scopeSnapshot,
    filters: { ...sanitizedExportFilters(req.body.filters), format },
  });
  const queue = getQueue("exports");
  await queue?.add(
    "generate",
    { exportId: job._id },
    { jobId: job._id, attempts: 3, backoff: { type: "exponential", delay: 5000 } },
  );
  return toExportJobDto(job.toObject());
}
export async function listExports(req) {
  const rows = await ExportJob.find(exportJobListQuery(req)).sort({ createdAt: -1 }).lean();
  return rows.map((row) => toExportJobDto(row));
}

export async function getExport(req) {
  const job = await ExportJob.findOne({
    _id: req.params.exportId ?? req.params.id,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!job) return null;
  assertExportJobAccessible(req, job);
  return toExportJobDto(job);
}

export async function downloadExportFile(req, res) {
  const job = await ExportJob.findOne({
    _id: req.params.exportId ?? req.params.id,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!job) throw errors.notFound("Export");
  assertExportJobAccessible(req, job);
  if (job.status !== ExportStatus.READY || !job.objectKey) {
    throw new AppError("EXPORT_NOT_READY", "This export is not ready to download yet.", 409);
  }
  if (job.downloadExpiresAt && job.downloadExpiresAt < new Date()) {
    throw new AppError("EXPORT_EXPIRED", "This export download link has expired.", 410);
  }
  let body;
  try {
    body = await storageProvider.readObjectBody(job.objectKey);
  } catch {
    throw new AppError("EXPORT_FILE_MISSING", "Export file is no longer available.", 404);
  }
  const format = (job.filters?.format ?? "CSV").toLowerCase();
  const ext = format === "pdf" ? "pdf" : "csv";
  res.setHeader("Content-Type", format === "pdf" ? "application/pdf" : "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="swarnagrow-${job.type.toLowerCase()}-${job._id}.${ext}"`,
  );
  res.send(body);
}
export async function auditEvents(req) { return listAuditEvents(req); }
