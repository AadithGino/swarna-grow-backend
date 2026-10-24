import { errors } from "../lib/app-error.js";
import {
  DigitalMetalBuyOrder,
  DigitalMetalRedemptionOrder,
  DigitalMetalSellOrder,
} from "../models/index.js";

/** Allow order history when holdings/legacy access exists or the customer has any DM orders. */
export async function assertCustomerDigitalMetalsOrderHistoryAccess(req) {
  const cap = req.digitalMetalsCapability;
  if (cap?.canViewHoldings || cap?.canViewHistory || cap?.hasLegacyActivity) return;
  const tenantId = req.auth.tenantId;
  const customerId = req.auth.id;
  const [buy, sell, redeem] = await Promise.all([
    DigitalMetalBuyOrder.exists({ tenantId, customerId }),
    DigitalMetalSellOrder.exists({ tenantId, customerId }),
    DigitalMetalRedemptionOrder.exists({ tenantId, customerId }),
  ]);
  if (buy || sell || redeem) return;
  throw errors.forbidden("Digital metals order history is not available.");
}

export function parseCustomerOrderListQuery(req) {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const cursor = req.query.cursor ? String(req.query.cursor).trim() : null;
  const statusRaw = req.query.status ? String(req.query.status).trim() : "";
  const status = statusRaw && statusRaw.toUpperCase() !== "ALL" ? statusRaw : null;
  return { limit, cursor, status };
}

export function parseAdminScopedListQuery(req, { defaultLimit = 25, maxLimit = 100 } = {}) {
  const limit = Math.min(Math.max(Number(req.query.limit) || defaultLimit, 1), maxLimit);
  const cursor = req.query.cursor ? String(req.query.cursor).trim() : null;
  return { limit, cursor };
}

export function paginateByIdCursor(rows, limit) {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? pageRows[pageRows.length - 1]?._id ?? null : null;
  return {
    items: pageRows,
    meta: {
      nextCursor,
      hasMore,
      limit,
    },
  };
}
