import { Types } from "mongoose";
import {
  EcommerceCodCollectionStatus,
  EcommerceFulfilmentMode,
  EcommerceOrderCancellationRequestStatus,
  EcommerceOrderReturnRequestStatus,
  EcommerceOrderStatus,
  EcommercePaymentMethod,
} from "../constants/enums.js";
import { parseAdminOrderListDate } from "./ecommerce-admin-order-list-filter.js";

const ORDER_STATUS_SET = new Set(Object.values(EcommerceOrderStatus));
const PAYMENT_METHOD_SET = new Set(Object.values(EcommercePaymentMethod));
const FULFILMENT_MODE_SET = new Set(Object.values(EcommerceFulfilmentMode));

export const OPEN_RETURN_STATUSES = [
  EcommerceOrderReturnRequestStatus.PENDING_REVIEW,
  EcommerceOrderReturnRequestStatus.APPROVED,
  EcommerceOrderReturnRequestStatus.RECEIVED,
  EcommerceOrderReturnRequestStatus.INSPECTED,
];

export const OPEN_CANCELLATION_STATUSES = [
  EcommerceOrderCancellationRequestStatus.PENDING_DECISION,
  EcommerceOrderCancellationRequestStatus.APPROVED_PROCESSING,
];

/** Stable filter inputs for cursor hashing (excludes cursor/limit). */
export function normalizeAdminOrderListQuery(raw = {}) {
  const q = String(raw.q ?? "").trim().slice(0, 120);
  const status = String(raw.status ?? "").trim().toUpperCase();
  const paymentMethod = String(raw.paymentMethod ?? "").trim().toUpperCase();
  const fulfilmentMode = String(raw.fulfilmentMode ?? "").trim().toUpperCase();
  const collected = String(raw.collected ?? "").trim().toLowerCase();
  const codPendingAcceptance =
    String(raw.codPendingAcceptance ?? "").trim().toLowerCase() === "true";
  const cancellationPending =
    String(raw.cancellationPending ?? "").trim().toLowerCase() === "true";
  const returnPending = String(raw.returnPending ?? "").trim().toLowerCase() === "true";
  const paymentException =
    String(raw.paymentException ?? "").trim().toLowerCase() === "true";

  const out = {};
  if (q) out.q = q;
  if (status && ORDER_STATUS_SET.has(status)) out.status = status;
  if (paymentMethod && PAYMENT_METHOD_SET.has(paymentMethod)) out.paymentMethod = paymentMethod;
  if (fulfilmentMode && FULFILMENT_MODE_SET.has(fulfilmentMode)) out.fulfilmentMode = fulfilmentMode;
  if (String(raw.createdFrom ?? "").trim()) out.createdFrom = String(raw.createdFrom).trim();
  if (String(raw.createdTo ?? "").trim()) out.createdTo = String(raw.createdTo).trim();
  if (paymentException) out.paymentException = true;
  if (codPendingAcceptance) out.codPendingAcceptance = true;
  if (cancellationPending) out.cancellationPending = true;
  if (returnPending) out.returnPending = true;
  if (collected === "true" || collected === "false") out.collected = collected;
  return out;
}

/** @param {string} tenantId @param {ReturnType<normalizeAdminOrderListQuery>} query @param {{ returnPendingOrderIds?: string[] }} [ctx] */
export function buildAdminOrderListMongoFilter(tenantId, query, ctx = {}) {
  const filter = { tenantId };

  if (query.paymentMethod) filter.paymentMethod = query.paymentMethod;
  if (query.status) filter.status = query.status;
  if (query.fulfilmentMode) filter.fulfilmentMode = query.fulfilmentMode;

  if (query.paymentException) {
    filter.paymentExceptionStatus = { $ne: null };
  }

  if (query.codPendingAcceptance) {
    filter.status = EcommerceOrderStatus.COD_PENDING_ACCEPTANCE;
  }

  if (query.cancellationPending) {
    filter.activeCancellationRequestId = { $exists: true, $ne: null };
  }

  if (query.returnPending) {
    const ids = ctx.returnPendingOrderIds ?? [];
    filter._id = { $in: ids.length ? ids : ["__no_matching_order__"] };
  }

  if (query.collected === "true") {
    filter.$and = [
      ...(filter.$and ?? []),
      {
        $or: [
          { paymentMethod: EcommercePaymentMethod.ONLINE, paidAt: { $ne: null } },
          {
            paymentMethod: EcommercePaymentMethod.COD,
            "codCollection.status": EcommerceCodCollectionStatus.COLLECTED,
          },
        ],
      },
    ];
  } else if (query.collected === "false") {
    filter.$and = [
      ...(filter.$and ?? []),
      {
        $nor: [
          { paymentMethod: EcommercePaymentMethod.ONLINE, paidAt: { $ne: null } },
          {
            paymentMethod: EcommercePaymentMethod.COD,
            "codCollection.status": EcommerceCodCollectionStatus.COLLECTED,
          },
        ],
      },
    ];
  }

  const createdFrom = parseAdminOrderListDate(query.createdFrom);
  const createdTo = parseAdminOrderListDate(query.createdTo, { endOfDay: true });
  if (createdFrom || createdTo) {
    filter.createdAt = {};
    if (createdFrom) filter.createdAt.$gte = createdFrom;
    if (createdTo) filter.createdAt.$lte = createdTo;
  }

  if (query.q) {
    const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const or = [
      { orderNumber: { $regex: escaped, $options: "i" } },
      { customerId: { $regex: escaped, $options: "i" } },
    ];
    if (Types.ObjectId.isValid(query.q)) {
      or.push({ _id: query.q });
    }
    const searchOr = { $or: or };
    if (filter.$and) filter.$and.push(searchOr);
    else if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, searchOr];
      delete filter.$or;
    } else {
      filter.$or = or;
    }
  }

  return filter;
}
