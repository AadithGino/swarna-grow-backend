import { errors } from "../lib/app-error.js";
import { EcommerceOrder, EcommerceOrderReturnRequest } from "../models/index.js";

function mapReturnSummary(row) {
  if (!row) return null;
  return {
    id: row._id,
    orderId: row.orderId,
    kind: row.kind,
    status: row.status,
    reason: row.reason,
    version: row.version ?? 1,
    onlineRefundId: row.onlineRefundId ?? null,
    manualRefundRecordedAt: row.manualRefundRecordedAt ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

export async function listAdminOrderReturns(req) {
  const tenantId = req.auth.tenantId;
  const orderId = String(req.params.orderId ?? "").trim();
  const order = await EcommerceOrder.findOne({ _id: orderId, tenantId }).select("_id").lean();
  if (!order) throw errors.notFound("Order");
  const rows = await EcommerceOrderReturnRequest.find({ tenantId, orderId })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
  const active =
    rows.find((row) =>
      ["PENDING_REVIEW", "APPROVED", "RECEIVED", "INSPECTED"].includes(String(row.status ?? "")),
    ) ?? null;
  return {
    orderId,
    activeRequest: mapReturnSummary(active),
    items: rows.map(mapReturnSummary),
  };
}

export async function attachReturnSummaryToAdminOrder(tenantId, orderId) {
  const rows = await EcommerceOrderReturnRequest.find({ tenantId, orderId })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();
  const active =
    rows.find((row) =>
      ["PENDING_REVIEW", "APPROVED", "RECEIVED", "INSPECTED"].includes(String(row.status ?? "")),
    ) ?? null;
  return {
    activeRequest: mapReturnSummary(active),
    recent: rows.map(mapReturnSummary),
  };
}
