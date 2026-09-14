import { verifyAccessToken } from "../services/token.service.js";
import { asyncHandler } from "../lib/async-handler.js";
import { errors } from "../lib/app-error.js";
import { Customer, Tenant, User } from "../models/index.js";
import { TenantStatus, UserStatus } from "../constants/enums.js";

export const authenticate = asyncHandler(async (req, _res, next) => {
  const [scheme, token] = (req.headers.authorization ?? "").split(" ");
  if (scheme !== "Bearer" || !token) throw errors.unauthenticated();
  const claims = verifyAccessToken(token);
  req.auth = { id: claims.sub, type: claims.typ, tenantId: claims.tid, branchId: claims.bid ?? null, role: claims.rol, permissions: claims.per ?? [], deviceId: claims.did };
  if (claims.typ === "CUSTOMER") { const customer = await Customer.findOne({ _id: claims.sub, tenantId: claims.tid }).lean(); if (!customer || customer.status !== "ACTIVE") throw errors.unauthenticated(); }
  else { const user = await User.findById(claims.sub).lean(); if (!user || user.status !== UserStatus.ACTIVE) throw errors.unauthenticated(); }
  if (claims.tid) { const tenant = await Tenant.findById(claims.tid).lean(); if (!tenant || ![TenantStatus.ACTIVE, TenantStatus.PENDING_SETUP].includes(tenant.status)) throw errors.forbidden("This jewellery account is not active."); req.tenant = tenant; }
  next();
});

export const requireSubject = (...types) => (req, _res, next) => types.includes(req.auth?.type) ? next() : next(errors.forbidden());
export const requirePermission = (...required) => (req, _res, next) => {
  const permissions = req.auth?.permissions ?? [];
  return permissions.includes("*") || required.every((permission) => permissions.includes(permission)) ? next() : next(errors.forbidden());
};

export function tenantScope(req, _res, next) {
  if (!req.auth?.tenantId) throw errors.forbidden();
  const actingBranch = req.headers["x-acting-branch-id"];
  if (actingBranch && req.auth.role !== "TENANT_OWNER") throw errors.forbidden("Only a tenant owner can select an acting branch.");
  req.scope = { tenantId: req.auth.tenantId, ...(req.auth.branchId || actingBranch ? { branchId: req.auth.branchId || actingBranch } : {}) };
  next();
}
