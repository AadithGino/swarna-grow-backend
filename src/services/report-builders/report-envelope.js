import { AppError } from "../../lib/app-error.js";
import { moneyRef, weightRef } from "../../lib/money.js";
import { dateMatch, resolveDatePreset } from "../../lib/query-filters.js";
import { Branch, Scheme } from "../../models/index.js";

export { dateMatch };

export const EXPORT_FORMATS = Object.freeze(["CSV", "XLSX", "PDF"]);

const MONTH_MS = 366 * 24 * 60 * 60 * 1000;

export function resolveReportPeriod(query = {}) {
  return resolveDatePreset(query.period ?? "THIS_MONTH", query);
}

export function assertReportRange(query = {}) {
  const { from, to } = resolveReportPeriod(query);
  if (!from || !to) return { from, to };
  const rangeMs = new Date(`${to}T23:59:59.999+05:30`) - new Date(`${from}T00:00:00+05:30`);
  if (rangeMs < 0) throw new AppError("REPORT_RANGE_INVALID", "Report end date must be on or after start date.", 422);
  if (rangeMs > 12 * MONTH_MS) {
    throw new AppError("REPORT_RANGE_TOO_LARGE", "Report range cannot exceed 12 months. Use async export for longer ranges.", 422);
  }
  return { from, to };
}

/** Tenant/branch filter for report queries (honours ?branchId for tenant-wide roles). */
export function reportDataScope(req) {
  if (req.scope.branchId) return { ...req.scope };
  const branchId = req.query.branchId ? String(req.query.branchId) : null;
  if (branchId) return { ...req.scope, branchId };
  return { ...req.scope };
}

export async function schemeIdsForPlan(scope, planId) {
  if (!planId) return null;
  const ids = await Scheme.find({ ...scope, planId: String(planId) }).distinct("_id");
  return ids.length ? ids : ["__no_matching_scheme__"];
}

export function reportScope(req) {
  const branchId = req.query.branchId || req.scope.branchId;
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
