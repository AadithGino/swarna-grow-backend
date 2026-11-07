import { ROLE_SCOPE } from "../constants/permissions.js";
import { EcommerceFulfilmentMode } from "../constants/enums.js";
import { errors } from "./app-error.js";
import { Customer, EcommerceOrder } from "../models/index.js";

const NO_ORDERS = "__no_branch_orders__";

export function ecommerceAdminRoleScope(req) {
  return ROLE_SCOPE[req.auth?.role] ?? "BRANCH";
}

export function ecommerceAdminBranchId(req) {
  return req.scope?.branchId ?? req.auth?.branchId ?? null;
}

/** Persisted branch ownership for admin ecommerce order access (not caller-supplied). */
export async function resolveEcommerceOrderResourceBranchId(order) {
  let customerBranchId = null;
  if (order?.customerId) {
    const cust = await Customer.findOne({ _id: order.customerId, tenantId: order.tenantId })
      .select("branchId")
      .lean();
    customerBranchId = cust?.branchId ?? null;
  }
  if (order?.fulfilmentMode === EcommerceFulfilmentMode.BRANCH_PICKUP) {
    return order.pickupBranchId ?? customerBranchId;
  }
  return customerBranchId;
}

export async function assertAdminEcommerceOrderInScope(req, order) {
  if (req.auth?.type !== "TENANT_USER") throw errors.forbidden();
  if (String(order.tenantId) !== String(req.auth.tenantId)) throw errors.notFound("Order");
  const roleScope = ecommerceAdminRoleScope(req);
  if (roleScope === "TENANT") return;
  const actorBranchId = ecommerceAdminBranchId(req);
  if (!actorBranchId) throw errors.forbidden("Branch scope is required for this role.");
  const resourceBranchId = await resolveEcommerceOrderResourceBranchId(order);
  if (resourceBranchId == null) {
    throw errors.forbidden("Order branch scope could not be determined.");
  }
  if (String(resourceBranchId) !== String(actorBranchId)) {
    throw errors.forbidden("Order is outside your branch scope.");
  }
}

const ORDER_SCOPE_PROJECTION = "tenantId customerId fulfilmentMode pickupBranchId";

export async function loadEcommerceOrderForAdmin(req, orderId, { session, lean = true, select } = {}) {
  const query = EcommerceOrder.findOne({ _id: orderId, tenantId: req.auth.tenantId });
  if (select) {
    const fields = new Set(`${select} ${ORDER_SCOPE_PROJECTION}`.split(/\s+/).filter(Boolean));
    query.select([...fields].join(" "));
  }
  if (session) query.session(session);
  const order = lean ? await query.lean() : await query;
  if (!order) throw errors.notFound("Order");
  await assertAdminEcommerceOrderInScope(req, order);
  return order;
}

async function branchCustomerIds(tenantId, branchId) {
  const rows = await Customer.find({ tenantId, branchId }).select("_id").lean();
  return rows.map((c) => c._id);
}

/** Tenant + branch-scoped Mongo filter for ecommerce orders (lists, counts, aggregates). */
export async function buildAdminEcommerceOrderMongoScope(req, extra = {}) {
  const filter = { tenantId: req.auth.tenantId, ...extra };
  await applyAdminEcommerceOrderBranchFilter(req, filter);
  return filter;
}

/** Merge branch order scope into a Mongo filter before pagination/count. */
export async function applyAdminEcommerceOrderBranchFilter(req, filter) {
  if (req.auth?.type !== "TENANT_USER") return filter;
  const roleScope = ecommerceAdminRoleScope(req);
  if (roleScope === "TENANT") return filter;
  const branchId = ecommerceAdminBranchId(req);
  if (!branchId) throw errors.forbidden("Branch scope is required for this role.");
  const customerIds = await branchCustomerIds(req.auth.tenantId, branchId);
  const branchScopeOr = [
    { pickupBranchId: branchId },
    {
      fulfilmentMode: EcommerceFulfilmentMode.DELIVERY,
      customerId: { $in: customerIds.length ? customerIds : [NO_ORDERS] },
    },
    {
      fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
      pickupBranchId: null,
      customerId: { $in: customerIds.length ? customerIds : [NO_ORDERS] },
    },
  ];
  filter.$and = [...(filter.$and ?? []), { $or: branchScopeOr }];
  return filter;
}

export async function filterOrderIdsInAdminBranchScope(req, orderIds) {
  if (!orderIds?.length) return [];
  const roleScope = ecommerceAdminRoleScope(req);
  if (roleScope === "TENANT") return orderIds;
  const branchId = ecommerceAdminBranchId(req);
  if (!branchId) throw errors.forbidden("Branch scope is required for this role.");
  const orders = await EcommerceOrder.find({
    tenantId: req.auth.tenantId,
    _id: { $in: orderIds },
  })
    .select("_id tenantId customerId fulfilmentMode pickupBranchId")
    .lean();
  const allowed = [];
  for (const order of orders) {
    try {
      await assertAdminEcommerceOrderInScope(req, order);
      allowed.push(order._id);
    } catch {
      /* drop */
    }
  }
  return allowed;
}
