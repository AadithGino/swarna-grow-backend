import { buildAdminReport } from "../services/report-builders/index.js";
import { AppError } from "./app-error.js";

export const EXPORT_REPORT_TYPE_MAP = Object.freeze({
  COLLECTION: "COLLECTION",
  OUTSTANDING: "OUTSTANDING",
  GOLD_ACCRUAL: "GOLD_ACCRUAL",
  STAFF_PERFORMANCE: "STAFF_PERFORMANCE",
  DEFAULTER: "DEFAULTER",
  MATURITY: "MATURITY_REDEMPTION",
});

const RAW_EXPORT_TYPES = new Set(["AUDIT", "CUSTOMER", "SCHEME"]);

export function isRawExportType(type) {
  return RAW_EXPORT_TYPES.has(type);
}

export function exportReportKey(type) {
  return EXPORT_REPORT_TYPE_MAP[type] ?? null;
}

export function exportReqFromJob(record) {
  return {
    auth: { id: record.requestedBy, tenantId: record.tenantId, type: "TENANT_USER" },
    scope: {
      tenantId: record.tenantId,
      ...(record.filters?.branchId ? { branchId: record.filters.branchId } : {}),
    },
    query: {
      ...record.filters,
      limit: 100_000,
      offset: 0,
    },
  };
}

function reportCellValue(value) {
  if (value == null) return "";
  if (typeof value !== "object") return String(value);
  if (value.amountDisplay) return value.amountDisplay;
  if (value.weightDisplay) return value.weightDisplay;
  if (value.label) return value.label;
  if (value.name) return value.name;
  if (Number.isFinite(value.amountPaise)) return String(value.amountPaise);
  if (Number.isFinite(value.weightMg)) return String(value.weightMg);
  return JSON.stringify(value);
}

export async function buildReportExportRows(record) {
  const reportKey = exportReportKey(record.type);
  if (!reportKey) {
    throw new AppError(
      "EXPORT_TYPE_NOT_SUPPORTED",
      `Export type ${record.type} is not supported yet.`,
      501,
      { type: record.type },
    );
  }
  const report = await buildAdminReport(exportReqFromJob(record), reportKey);
  if (!report) {
    throw new AppError(
      "EXPORT_TYPE_NOT_SUPPORTED",
      `Export type ${record.type} is not supported yet.`,
      501,
      { type: record.type },
    );
  }
  const columns = report.columns ?? [];
  const rows = report.rows ?? [];
  return {
    headers: columns.map((column) => column.label ?? column.key),
    keys: columns.map((column) => column.key),
    rows: rows.map((row) => columns.map((column) => reportCellValue(row[column.key]))),
  };
}
