import { paginate } from "../lib/pagination.js";
import {
  buildAdminOrderListMongoFilter,
  normalizeAdminOrderListQuery,
  OPEN_RETURN_STATUSES,
} from "../lib/ecommerce-admin-order-list-filter.js";
import { attachAdminOrderCustomerDisplay } from "../lib/ecommerce-admin-order-customer-display.js";
import {
  applyAdminEcommerceOrderBranchFilter,
  filterOrderIdsInAdminBranchScope,
} from "../lib/ecommerce-admin-order-scope.js";
import { EcommerceOrder, EcommerceOrderReturnRequest } from "../models/index.js";

const MAX_TOTAL_COUNT = 50_000;

async function returnPendingOrderIds(req, tenantId) {
  const raw = await EcommerceOrderReturnRequest.find({
    tenantId,
    status: { $in: OPEN_RETURN_STATUSES },
  }).distinct("orderId");
  return filterOrderIdsInAdminBranchScope(req, raw);
}

export async function listAdminOrdersPaginated(req, mapRow) {
  const tenantId = req.auth.tenantId;
  const normalized = normalizeAdminOrderListQuery(req.query ?? {});
  const ctx = {};
  if (normalized.returnPending) {
    ctx.returnPendingOrderIds = await returnPendingOrderIds(req, tenantId);
  }
  const scope = buildAdminOrderListMongoFilter(tenantId, normalized, ctx);
  await applyAdminEcommerceOrderBranchFilter(req, scope);
  const sort = "createdAt:desc";

  const [page, totalCountRaw] = await Promise.all([
    paginate(EcommerceOrder, {
      scope,
      filters: {},
      cursorFilters: normalized,
      cursor: req.query?.cursor,
      limit: req.query?.limit,
      sort,
    }),
    EcommerceOrder.countDocuments(scope),
  ]);

  const totalCount = Math.min(totalCountRaw, MAX_TOTAL_COUNT);
  const totalCountCapped = totalCountRaw > MAX_TOTAL_COUNT;

  const mapped = await Promise.all(page.data.map((row) => mapRow(row)));
  const items = await attachAdminOrderCustomerDisplay(tenantId, mapped);

  return {
    items,
    meta: {
      ...page.meta,
      totalCount,
      totalCountCapped,
      sort,
    },
  };
}
