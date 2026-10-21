import { ROLE_SCOPE } from "../constants/permissions.js";
import { errors } from "../lib/app-error.js";
import { Customer } from "../models/index.js";
import { assertTenantOwnsCustomerScope } from "../services/digital-metals.service.js";

const NO_CUSTOMERS = "__no_branch_customers__";

export function digitalMetalsAdminRoleScope(req) {
  return ROLE_SCOPE[req.auth?.role] ?? "BRANCH";
}

export function digitalMetalsAdminBranchId(req) {
  return req.scope?.branchId ?? req.auth?.branchId ?? null;
}

export async function assertAdminCustomerInScope(req, customerId) {
  if (!customerId || req.auth?.type === "CUSTOMER") return null;
  if (req.auth?.type !== "TENANT_USER") throw errors.forbidden();
  const cust = await Customer.findOne({ _id: customerId, tenantId: req.auth.tenantId }).lean();
  if (!cust) throw errors.notFound("Customer");
  assertTenantOwnsCustomerScope(req, cust);
  return cust;
}

/** Merge branch customer scope into a Mongo filter (before limit/sort). */
export async function applyAdminCustomerScopeFilter(req, filter, { customerIdQuery } = {}) {
  if (req.auth?.type === "CUSTOMER") {
    filter.customerId = req.auth.id;
    return filter;
  }
  const roleScope = digitalMetalsAdminRoleScope(req);
  const explicitCustomerId = customerIdQuery ? String(customerIdQuery).trim() : "";
  if (explicitCustomerId) {
    await assertAdminCustomerInScope(req, explicitCustomerId);
    filter.customerId = explicitCustomerId;
    return filter;
  }
  if (roleScope === "TENANT") return filter;
  const branchId = digitalMetalsAdminBranchId(req);
  if (!branchId) throw errors.forbidden("Branch scope is required for this role.");
  const rows = await Customer.find({ tenantId: req.auth.tenantId, branchId }).select("_id").lean();
  const ids = rows.map((c) => c._id);
  filter.customerId = { $in: ids.length ? ids : [NO_CUSTOMERS] };
  return filter;
}

export async function applyAdminBuyOrderBranchFilter(req, filter) {
  const roleScope = digitalMetalsAdminRoleScope(req);
  if (roleScope === "BRANCH") {
    const branchId = digitalMetalsAdminBranchId(req);
    if (!branchId) throw errors.forbidden("Branch scope is required for this role.");
    filter.branchId = branchId;
  }
  await applyAdminCustomerScopeFilter(req, filter, { customerIdQuery: req.query?.customerId });
  return filter;
}

export async function assertAdminDigitalMetalsCustomerSubject(req, customerId) {
  if (req.auth?.type === "CUSTOMER") {
    if (customerId && customerId !== req.auth.id) throw errors.forbidden();
    return;
  }
  if (customerId) await assertAdminCustomerInScope(req, customerId);
}
