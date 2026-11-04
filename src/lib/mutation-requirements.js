/**
 * Shared guards for financial/fulfilment mutations (legacy routes included).
 * Every mutation must also enforce business amount/qty limits at the service layer.
 */
import { AppError } from "./app-error.js";
import { errors } from "./app-error.js";
import { ROLE_SCOPE, ROLE_PERMISSIONS } from "../constants/permissions.js";
import { hashIdempotencyBody } from "../services/idempotency.service.js";

export function requireIdempotencyKey(req, { header = "x-idempotency-key", fieldName = "x-idempotency-key" } = {}) {
  const key = String(req.headers?.[header] ?? req.headers?.[header.toLowerCase()] ?? "").trim();
  if (!key) {
    throw errors.validation([{ field: fieldName, message: "Required." }]);
  }
  return key;
}

export function hashMutationBody(body) {
  return hashIdempotencyBody(body ?? {});
}

/** Reject idempotency replays when the request body does not match the original hash. */
export function assertIdempotencyBodyMatches(idempotencyRecord, body) {
  if (!idempotencyRecord) return;
  const bodyHash = hashMutationBody(body);
  if (idempotencyRecord.bodyHash !== bodyHash) {
    throw new AppError(
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was already used with a different request.",
      409,
    );
  }
}

export function requireExpectedVersion(body, { field = "expectedVersion" } = {}) {
  const expectedVersion = Number(body?.[field]);
  if (!Number.isInteger(expectedVersion)) {
    throw errors.validation([{ field, message: "expectedVersion is required." }]);
  }
  return expectedVersion;
}

export function assertDocumentVersion(doc, expectedVersion, { entity = "Record" } = {}) {
  const current = Number(doc?.version ?? 0);
  if (current !== expectedVersion) {
    throw errors.conflict("VERSION_CONFLICT", `${entity} changed elsewhere. Refresh and retry.`);
  }
}

export function assertSameTenant(authTenantId, docTenantId) {
  if (String(authTenantId) !== String(docTenantId)) {
    throw new AppError("FORBIDDEN", "Tenant scope mismatch.", 403);
  }
}

export function resolveStaffBranchId(req) {
  return req.scope?.branchId ?? req.auth?.branchId ?? null;
}

export function staffRoleScope(req) {
  return ROLE_SCOPE[req.auth?.role] ?? "BRANCH";
}

/**
 * Branch-scoped staff may only mutate resources tied to their branch (when resourceBranchId is set).
 * Tenant-wide roles skip branch equality checks but still require tenant match elsewhere.
 */
export function assertBranchScopeForMutation(req, { resourceBranchId = null, customerBranchId = null } = {}) {
  const scope = staffRoleScope(req);
  if (scope === "TENANT") return;
  const actorBranchId = resolveStaffBranchId(req);
  if (!actorBranchId) {
    throw errors.forbidden("Branch scope is required for this role.");
  }
  const targetBranch = resourceBranchId ?? customerBranchId;
  if (targetBranch != null && String(targetBranch) !== String(actorBranchId)) {
    throw errors.forbidden("Resource is outside your branch scope.");
  }
}

export function assertMutationPermission(req, permission) {
  const role = req.auth?.role;
  const allowed = ROLE_PERMISSIONS[role] ?? [];
  if (allowed.includes("*") || allowed.includes(permission)) return;
  throw errors.forbidden("Insufficient permission for this action.");
}
