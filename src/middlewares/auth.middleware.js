import { verifyAccessToken } from "../services/token.service.js";
import { asyncHandler } from "../lib/async-handler.js";
import { errors } from "../lib/app-error.js";
import { Customer, Session, Tenant, User } from "../models/index.js";
import { TenantStatus, UserStatus } from "../constants/enums.js";
import {
  ROLE_SCOPE,
  collectionAgentPermissions,
} from "../constants/permissions.js";
import { assertSubscriptionActive } from "../lib/tenant-limits.js";
import { attachSubscriptionCatalogPlan } from "../lib/subscription-plan-for-tenant.js";

export const authenticate = asyncHandler(async (req, _res, next) => {
  const [scheme, token] = (req.headers.authorization ?? "").split(" ");
  if (scheme !== "Bearer" || !token) throw errors.unauthenticated();
  const claims = verifyAccessToken(token);
  req.auth = {
    id: claims.sub,
    type: claims.typ,
    tenantId: claims.tid,
    branchId: claims.bid ?? null,
    role: claims.rol,
    permissions: claims.per ?? [],
    deviceId: claims.did,
    sessionId: claims.sid,
  };
  if (!claims.sid)
    throw errors.unauthenticated(
      "This access token is not bound to a live session.",
    );
  const sessionSubject =
    claims.typ === "CUSTOMER"
      ? { customerId: claims.sub }
      : { userId: claims.sub };
  const liveSession = await Session.exists({
    _id: claims.sid,
    ...sessionSubject,
    tenantId: claims.tid ?? null,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  if (!liveSession)
    throw errors.unauthenticated(
      "This session has been signed out or revoked.",
    );
  if (claims.typ === "CUSTOMER") {
    const customer = await Customer.findOne({
      _id: claims.sub,
      tenantId: claims.tid,
    }).lean();
    if (!customer || customer.status !== "ACTIVE")
      throw errors.unauthenticated();
    if ((claims.sv ?? 0) !== (customer.securityVersion ?? 0))
      throw errors.unauthenticated(
        "Your session is no longer valid. Sign in again.",
      );
  } else {
    const user = await User.findById(claims.sub).lean();
    if (!user || user.status !== UserStatus.ACTIVE)
      throw errors.unauthenticated();
    if (
      claims.tid != null &&
      String(user.tenantId ?? "") !== String(claims.tid)
    ) {
      throw errors.unauthenticated();
    }
    if (claims.typ != null && user.type != null && claims.typ !== user.type) {
      throw errors.unauthenticated();
    }
    if ((claims.sv ?? 0) !== (user.securityVersion ?? 0))
      throw errors.unauthenticated(
        "Your session is no longer valid. Sign in again.",
      );
  }
  if (claims.tid) {
    const tenant = await Tenant.findById(claims.tid).lean();
    if (
      !tenant ||
      ![TenantStatus.ACTIVE, TenantStatus.PENDING_SETUP].includes(tenant.status)
    ) {
      throw errors.forbidden("This jewellery account is not active.");
    }
    assertSubscriptionActive(tenant);
    req.tenant = await attachSubscriptionCatalogPlan(tenant);
  }
  if (req.auth.role === "COLLECTION_AGENT") {
    req.auth.permissions = collectionAgentPermissions(req.tenant, {
      includeCapabilities: false,
    });
  }
  next();
});

/** Adds tenant-enabled agent capabilities for the field (/staff) API only. */
export function applyAgentCapabilities(req, _res, next) {
  if (req.auth?.role === "COLLECTION_AGENT") {
    req.auth.permissions = collectionAgentPermissions(req.tenant);
  }
  next();
}

export const requireSubject =
  (...types) =>
  (req, _res, next) =>
    types.includes(req.auth?.type) ? next() : next(errors.forbidden());
export const requirePermission =
  (...required) =>
  (req, _res, next) => {
    const permissions = req.auth?.permissions ?? [];
    return permissions.includes("*") ||
      required.every((permission) => permissions.includes(permission))
      ? next()
      : next(errors.forbidden());
  };

export function tenantScope(req, _res, next) {
  if (!req.auth?.tenantId) throw errors.forbidden();
  const actingBranch = req.headers["x-acting-branch-id"];
  if (actingBranch && req.auth.role !== "TENANT_OWNER")
    throw errors.forbidden("Only a tenant owner can select an acting branch.");
  const roleScope = ROLE_SCOPE[req.auth.role] ?? "BRANCH";
  let branchId = actingBranch || req.auth.branchId || null;
  if (!branchId && roleScope === "TENANT") {
    const rawQueryBranch =
      req.query?.branchId != null ? String(req.query.branchId).trim() : "";
    const queryBranch =
      rawQueryBranch && rawQueryBranch.toUpperCase() !== "ALL"
        ? rawQueryBranch
        : null;
    if (queryBranch) branchId = queryBranch;
  }
  req.scope = { tenantId: req.auth.tenantId };
  if (roleScope === "BRANCH") {
    if (!branchId)
      throw errors.forbidden("Branch scope is required for this role.");
    req.scope.branchId = branchId;
  } else if (branchId) req.scope.branchId = branchId;
  next();
}
