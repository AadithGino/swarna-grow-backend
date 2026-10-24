import {
  DigitalMetalBuyOrder,
  DigitalMetalBuyPaymentAttempt,
  DigitalMetalRedemptionOrder,
  DigitalMetalSellOrder,
} from "../models/index.js";
import { mapBuyOrderStatusDto } from "./digital-metals-buy-finalize.service.js";
import { mapSellOrderDto } from "./digital-metals-sell.service.js";
import { mapRedemptionOrder } from "./digital-metals-redemption.service.js";
import {
  assertCustomerDigitalMetalsOrderHistoryAccess,
  paginateByIdCursor,
  parseCustomerOrderListQuery,
} from "../lib/digital-metals-customer-order-access.js";
import {
  CUSTOMER_OPEN_BUY_ORDER_STATUSES,
  CUSTOMER_OPEN_REDEMPTION_ORDER_STATUSES,
  CUSTOMER_OPEN_SELL_ORDER_STATUSES,
} from "../lib/digital-metals-open-work-statuses.js";

function baseCustomerFilter(req) {
  return { tenantId: req.auth.tenantId, customerId: req.auth.id };
}

export async function listCustomerBuyOrders(req) {
  await assertCustomerDigitalMetalsOrderHistoryAccess(req);
  const { limit, cursor, status } = parseCustomerOrderListQuery(req);
  const filter = baseCustomerFilter(req);
  if (status) filter.status = status;
  if (cursor) filter._id = { $lt: cursor };
  const rows = await DigitalMetalBuyOrder.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const { items, meta } = paginateByIdCursor(rows, limit);
  const orderIds = items.map((o) => o._id);
  const attempts = orderIds.length
    ? await DigitalMetalBuyPaymentAttempt.find({
        tenantId: req.auth.tenantId,
        orderId: { $in: orderIds },
      })
        .sort({ createdAt: -1 })
        .lean()
    : [];
  const attemptsByOrder = new Map();
  for (const a of attempts) {
    if (!attemptsByOrder.has(a.orderId)) attemptsByOrder.set(a.orderId, []);
    attemptsByOrder.get(a.orderId).push(a);
  }
  return {
    items: items.map((o) => mapBuyOrderStatusDto(o, attemptsByOrder.get(o._id) ?? [])),
    meta,
  };
}

export async function listCustomerSellOrders(req) {
  await assertCustomerDigitalMetalsOrderHistoryAccess(req);
  const { limit, cursor, status } = parseCustomerOrderListQuery(req);
  const filter = baseCustomerFilter(req);
  if (status) filter.status = status;
  if (cursor) filter._id = { $lt: cursor };
  const rows = await DigitalMetalSellOrder.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const { items, meta } = paginateByIdCursor(rows, limit);
  return {
    items: items.map((o) => mapSellOrderDto(o)),
    meta,
  };
}

export async function listCustomerRedemptionOrders(req) {
  await assertCustomerDigitalMetalsOrderHistoryAccess(req);
  const { limit, cursor, status } = parseCustomerOrderListQuery(req);
  const filter = baseCustomerFilter(req);
  if (status) filter.status = status;
  if (cursor) filter._id = { $lt: cursor };
  const rows = await DigitalMetalRedemptionOrder.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const { items, meta } = paginateByIdCursor(rows, limit);
  return {
    items: items.map((o) => mapRedemptionOrder(o)),
    meta,
  };
}

export async function listCustomerOpenOrdersSummary(req) {
  await assertCustomerDigitalMetalsOrderHistoryAccess(req);
  const base = baseCustomerFilter(req);
  const [buyCount, sellCount, redeemCount] = await Promise.all([
    DigitalMetalBuyOrder.countDocuments({ ...base, status: { $in: [...CUSTOMER_OPEN_BUY_ORDER_STATUSES] } }),
    DigitalMetalSellOrder.countDocuments({ ...base, status: { $in: [...CUSTOMER_OPEN_SELL_ORDER_STATUSES] } }),
    DigitalMetalRedemptionOrder.countDocuments({
      ...base,
      status: { $in: [...CUSTOMER_OPEN_REDEMPTION_ORDER_STATUSES] },
    }),
  ]);
  return {
    openBuyCount: buyCount,
    openSellCount: sellCount,
    openRedemptionCount: redeemCount,
    totalOpen: buyCount + sellCount + redeemCount,
  };
}
