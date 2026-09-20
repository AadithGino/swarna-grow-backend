import { env } from "../config/env.js";
import { AppError } from "./app-error.js";
import { ExportJob } from "../models/index.js";
import { ExportStatus } from "../constants/enums.js";

export function maxSyncReportRows() {
  return env.REPORT_MAX_SYNC_ROWS ?? 5_000;
}

export function maxExportRows() {
  return env.REPORT_EXPORT_MAX_ROWS ?? 200_000;
}

export function maxExportBytes() {
  return env.REPORT_EXPORT_MAX_BYTES ?? 52_428_800;
}

export function maxExportRuntimeMs() {
  return env.REPORT_EXPORT_MAX_RUNTIME_MS ?? 600_000;
}

export function maxConcurrentExportsPerTenant() {
  return env.REPORT_EXPORT_MAX_CONCURRENT_PER_TENANT ?? 3;
}

export function assertSyncReportRowCount(count, { reportKey } = {}) {
  const max = maxSyncReportRows();
  if (count > max) {
    throw new AppError(
      "REPORT_TOO_LARGE",
      "This report has too many rows for synchronous viewing. Use async export with filters or a shorter date range.",
      422,
      { rowCount: count, maxRows: max, reportKey },
    );
  }
}

export function assertExportRowCount(count) {
  const max = maxExportRows();
  if (count > max) {
    throw new AppError(
      "EXPORT_TOO_LARGE",
      "This export exceeds the maximum allowed row count.",
      422,
      { rowCount: count, maxRows: max },
    );
  }
}

export async function assertExportConcurrency(tenantId) {
  const max = maxConcurrentExportsPerTenant();
  const active = await ExportJob.countDocuments({
    tenantId,
    status: { $in: [ExportStatus.QUEUED, ExportStatus.PROCESSING] },
  });
  if (active >= max) {
    throw new AppError(
      "EXPORT_CONCURRENCY_LIMIT",
      "Too many exports are already in progress for this account. Wait for one to finish before starting another.",
      429,
      { active, maxConcurrent: max },
    );
  }
}
