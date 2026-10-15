import { Branch } from "../models/index.js";
import { ROLE_SCOPE } from "../constants/permissions.js";
import { errors } from "./app-error.js";

function normalizeBranchId(value) {
  if (value == null || value === "" || value === "ALL") return null;
  return String(value).trim();
}

/** Resolve and enforce branch scope for scheme gold rate publish + notifications. */
export async function resolveAuthorizedSchemeGoldRateBranchId(req, requestedBranchId) {
  const tenantId = req.auth.tenantId;
  const roleScope = ROLE_SCOPE[req.auth?.role] ?? "BRANCH";
  const lockedBranch =
    roleScope === "BRANCH" ? (req.scope?.branchId ?? null) : null;
  const requested = normalizeBranchId(requestedBranchId);

  if (lockedBranch) {
    if (requested == null) {
      throw errors.forbidden("Tenant-wide gold rates require tenant-level access.");
    }
    if (requested !== lockedBranch) {
      throw errors.forbidden("You may publish gold rates only for your assigned branch.");
    }
    return lockedBranch;
  }

  if (requested == null) {
    return null;
  }

  const branch = await Branch.findOne({ _id: requested, tenantId, active: true }).lean();
  if (!branch) {
    throw errors.validation([{ field: "body.branchId", message: "Branch not found or inactive." }]);
  }
  return requested;
}
