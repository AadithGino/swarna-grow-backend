import { ROLE_SCOPE } from "../constants/permissions.js";
import { errors } from "./app-error.js";
import { scopeBranchId } from "./query-filters.js";
import { parseReportFocusId } from "../services/report-builders/report-envelope.js";

function branchRoleLocked(req) {
  return (ROLE_SCOPE[req.auth?.role] ?? "BRANCH") === "BRANCH";
}

/** Authoritative tenant/branch scope persisted on export jobs (not user filter blobs). */
export function resolveExportScopeSnapshot(req) {
  const tenantId = req.auth.tenantId;
  if (branchRoleLocked(req)) {
    const lockedBranch = scopeBranchId(req.scope?.branchId);
    if (!lockedBranch) {
      throw errors.forbidden("Branch scope is required for this role.");
    }
    return { tenantId, branchId: lockedBranch };
  }
  const requested = parseReportFocusId(req.body?.filters?.branchId);
  return { tenantId, branchId: requested };
}

export function sanitizedExportFilters(filters = {}) {
  if (!filters || typeof filters !== "object") return {};
  const { branchId: _ignored, ...rest } = filters;
  return rest;
}

export function exportScopeForWorker(record) {
  const snap = record.scopeSnapshot;
  if (snap?.tenantId) {
    return {
      tenantId: snap.tenantId,
      ...(snap.branchId ? { branchId: snap.branchId } : {}),
    };
  }
  return {
    tenantId: record.tenantId,
    ...(record.filters?.branchId ? { branchId: record.filters.branchId } : {}),
  };
}

export function exportJobListQuery(req) {
  const query = { tenantId: req.auth.tenantId };
  if (!branchRoleLocked(req)) return query;
  const lockedBranch = scopeBranchId(req.scope?.branchId);
  if (lockedBranch) {
    query["scopeSnapshot.branchId"] = lockedBranch;
  }
  return query;
}

export function assertExportJobAccessible(req, job) {
  if (!job || job.tenantId !== req.auth.tenantId) {
    throw errors.notFound("Export");
  }
  if (!branchRoleLocked(req)) return;
  const lockedBranch = scopeBranchId(req.scope?.branchId);
  if (!lockedBranch) return;
  const snap = job.scopeSnapshot;
  if (!snap) {
    throw errors.notFound("Export");
  }
  if (snap.branchId !== lockedBranch) {
    throw errors.notFound("Export");
  }
}
