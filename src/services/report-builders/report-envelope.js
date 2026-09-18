import { AppError } from "../../lib/app-error.js";
import { moneyRef } from "../../lib/money.js";
import { dateMatch, resolveQueryDateRange } from "../../lib/query-filters.js";
import {
  formatTrendBucketLabel,
  inferTrendGroupBy,
  iteratePeriodBuckets,
  weekStartYmd,
} from "../../lib/analytics-period.js";
import { Branch, Scheme } from "../../models/index.js";

export { dateMatch };

export const EXPORT_FORMATS = Object.freeze(["CSV", "PDF"]);

const MONTH_MS = 366 * 24 * 60 * 60 * 1000;

export function resolveReportPeriod(query = {}) {
  return resolveQueryDateRange({
    ...query,
    period: query.period ?? "THIS_MONTH",
  });
}

export function assertReportRange(query = {}) {
  const { from, to } = resolveReportPeriod(query);
  if (!from || !to) return { from, to };
  const rangeMs = new Date(`${to}T23:59:59.999+05:30`) - new Date(`${from}T00:00:00+05:30`);
  if (rangeMs < 0) throw new AppError("REPORT_RANGE_INVALID", "Report end date must be on or after start date.", 422);
  const maxMonths = query._asyncExport ? 60 : 12;
  if (rangeMs > maxMonths * MONTH_MS) {
    throw new AppError("REPORT_RANGE_TOO_LARGE", "Report range cannot exceed 12 months. Use async export for longer ranges.", 422);
  }
  return { from, to };
}

/** Tenant/branch filter for report queries (honours ?branchId for tenant-wide roles). */
export function reportDataScope(req) {
  const tenantId = req.scope?.tenantId ?? req.auth?.tenantId;
  const rawQueryBranch =
    req.query?.branchId != null ? String(req.query.branchId).trim() : "";
  if (
    rawQueryBranch.toUpperCase() === "ALL" &&
    hasTenantWideReportAccess(req.auth?.role)
  ) {
    return { tenantId };
  }
  const scopeBranchId = parseReportFocusId(req.scope?.branchId);
  if (scopeBranchId) return { ...req.scope, branchId: scopeBranchId };
  const branchId = parseReportFocusId(req.query.branchId);
  if (branchId) return { ...req.scope, branchId };
  return { ...req.scope };
}

/** Report focus ids from query params; `ALL`/blank means no drill-down focus. */
export function parseReportFocusId(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.toUpperCase() === "ALL") return null;
  return normalized;
}

/** Tenant-wide roles may compare all branches/plans even with an acting branch selected. */
export function hasTenantWideReportAccess(role) {
  return role === "TENANT_OWNER" || role === "TENANT_ADMIN";
}

export async function schemeIdsForPlan(scope, planId) {
  if (!planId) return null;
  const ids = await Scheme.find({ ...scope, planId: String(planId) }).distinct("_id");
  return ids.length ? ids : ["__no_matching_scheme__"];
}

export function reportScope(req) {
  const focusBranchId = parseReportFocusId(req.query.branchId);
  const scopeBranchId = parseReportFocusId(req.scope?.branchId);
  const branchId = focusBranchId ?? scopeBranchId;
  const comparingAll =
    !branchId &&
    String(req.query?.branchId ?? "")
      .trim()
      .toUpperCase() === "ALL" &&
    hasTenantWideReportAccess(req.auth?.role);
  if (comparingAll) {
    return { level: "TENANT", label: "All showrooms", branchId: null };
  }
  return {
    level: branchId ? "BRANCH" : "TENANT",
    label: branchId ? "Branch" : "All showrooms",
    branchId: branchId ?? null,
  };
}

export function periodBlock(from, to) {
  const label =
    from && to
      ? from === to
        ? from
        : `${from} – ${to}`
      : "All time";
  return { from, to, label };
}

export function generatedAtIst() {
  return new Date().toISOString().replace("Z", "+05:30").replace(/\.\d{3}/, "");
}

export async function branchNameMap(tenantId, branchIds = null) {
  const filter = { tenantId, ...(branchIds?.length ? { _id: { $in: [...new Set(branchIds)] } } : {}) };
  const rows = await Branch.find(filter).select("_id name").lean();
  return new Map(rows.map((row) => [row._id, row.name]));
}

export function maskMobile(mobile) {
  const s = String(mobile ?? "");
  if (s.length < 6) return s;
  return `${s.slice(0, 4)}XXXX${s.slice(-2)}`;
}

export function paginateRows(rows, query = {}) {
  if (query._exportAll) {
    return { rows, meta: { nextCursor: null, hasMore: false, limit: rows.length, total: rows.length } };
  }
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
  const offset = Math.max(Number(query.offset) || 0, 0);
  let start = offset;
  if (query.cursor) {
    const parsed = Number.parseInt(String(query.cursor), 10);
    if (Number.isFinite(parsed) && parsed >= 0) start = parsed;
  }
  const slice = rows.slice(start, start + limit);
  const nextStart = start + slice.length;
  const hasMore = nextStart < rows.length;
  return {
    rows: slice,
    meta: {
      nextCursor: hasMore ? String(nextStart) : null,
      hasMore,
      limit,
      total: rows.length,
    },
  };
}

export function ageingBucket(days) {
  if (days <= 7) return { value: "1_7", label: "1–7 days", severity: "LOW" };
  if (days <= 15) return { value: "8_15", label: "8–15 days", severity: "MEDIUM" };
  if (days <= 30) return { value: "16_30", label: "16–30 days", severity: "MEDIUM" };
  return { value: "30_PLUS", label: "30+ days", severity: "HIGH" };
}

export function daysBetweenCalendar(fromYmd, toYmd) {
  const a = new Date(`${fromYmd}T12:00:00+05:30`);
  const b = new Date(`${toYmd}T12:00:00+05:30`);
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

export function schemeInstallmentStats(scheme, asOfYmd) {
  const installments = scheme.installments ?? [];
  let expectedToDate = 0;
  let collectedToDate = 0;
  let futureExpected = 0;
  let overdueAmount = 0;
  let overdueCount = 0;
  let oldestOverdueDays = 0;

  for (const inst of installments) {
    const amt = inst.amountPaise ?? 0;
    const paid = inst.paidPaise ?? 0;
    collectedToDate += paid;
    if (inst.dueDate && inst.dueDate <= asOfYmd) expectedToDate += amt;
    else futureExpected += amt;

    if (inst.status === "OVERDUE") {
      overdueCount += 1;
      overdueAmount += Math.max(0, amt - paid);
      if (inst.dueDate) {
        const days = daysBetweenCalendar(inst.dueDate, asOfYmd);
        oldestOverdueDays = Math.max(oldestOverdueDays, days);
      }
    }
  }

  const outstandingOnDue = Math.max(0, expectedToDate - Math.min(collectedToDate, expectedToDate));

  return {
    expectedToDate,
    collectedToDate,
    futureExpected,
    overdueAmount,
    overdueCount,
    oldestOverdueDays,
    outstandingOnDue,
    paidTotal: collectedToDate,
  };
}

export function statusBadge(status) {
  const labels = {
    ACTIVE: "Active",
    LOCKED: "Locked",
    DEFAULTED: "Defaulted",
    MATURED: "Matured",
    REDEEMED: "Redeemed",
    CLOSED_PREMATURE: "Closed early",
  };
  return { value: status, label: labels[status] ?? status };
}

export function emptyMoney() {
  return moneyRef(0);
}

export function chartPointCurrency(x, amountPaise) {
  return { x, y: amountPaise, yDisplay: moneyRef(amountPaise).amountDisplay };
}

export function reportTrendGroupBy(from, to, query = {}) {
  return inferTrendGroupBy(from, to, query?.groupBy);
}

export function rollupDailyMetric(
  dailyRows,
  from,
  to,
  groupBy,
  valueField = "count",
) {
  const dailyMap = new Map(
    dailyRows.map((row) => [
      String(row._id),
      Number(row[valueField] ?? row.count ?? row.amountPaise ?? 0) || 0,
    ]),
  );

  if (groupBy === "DAY") {
    return [...iteratePeriodBuckets(from, to, "DAY")].map((key) => ({
      key,
      value: dailyMap.get(key) ?? 0,
    }));
  }

  if (groupBy === "WEEK") {
    const weekMap = new Map();
    for (const [day, value] of dailyMap) {
      const weekKey = weekStartYmd(day);
      weekMap.set(weekKey, (weekMap.get(weekKey) ?? 0) + value);
    }
    return [...iteratePeriodBuckets(from, to, "WEEK")].map((key) => ({
      key,
      value: weekMap.get(key) ?? 0,
    }));
  }

  if (groupBy === "MONTH") {
    const monthMap = new Map();
    for (const [day, value] of dailyMap) {
      const monthKey = day.slice(0, 7);
      monthMap.set(monthKey, (monthMap.get(monthKey) ?? 0) + value);
    }
    return [...iteratePeriodBuckets(from, to, "MONTH")].map((key) => ({
      key,
      value: monthMap.get(key) ?? 0,
    }));
  }

  const yearMap = new Map();
  for (const [day, value] of dailyMap) {
    const yearKey = day.slice(0, 4);
    yearMap.set(yearKey, (yearMap.get(yearKey) ?? 0) + value);
  }
  return [...iteratePeriodBuckets(from, to, "YEAR")].map((key) => ({
    key,
    value: yearMap.get(key) ?? 0,
  }));
}

export function buildCountTrendPoints(dailyRows, from, to, groupBy) {
  return rollupDailyMetric(dailyRows, from, to, groupBy).map((bucket) => ({
    x: bucket.key,
    xDisplay: formatTrendBucketLabel(bucket.key, groupBy),
    y: bucket.value,
    yDisplay: String(bucket.value),
  }));
}

export function buildCurrencyTrendPoints(dailyRows, from, to, groupBy) {
  return rollupDailyMetric(dailyRows, from, to, groupBy, "amountPaise").map(
    (bucket) => ({
      ...chartPointCurrency(bucket.key, bucket.value),
      xDisplay: formatTrendBucketLabel(bucket.key, groupBy),
    }),
  );
}

export function baseEnvelope(req, reportKey, title, extra = {}) {
  const { from, to } = assertReportRange(req.query);
  return {
    reportKey,
    title,
    scope: reportScope(req),
    period: periodBlock(from, to),
    generatedAt: generatedAtIst(),
    exportFormats: [...EXPORT_FORMATS],
    ...extra,
  };
}
