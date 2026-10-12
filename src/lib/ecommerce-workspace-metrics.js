import {
  EcommerceOrderCancellationRequestStatus,
  EcommerceOrderReturnRequestStatus,
  EcommerceOrderStatus,
  EcommercePaymentExceptionRefundStatus,
  EcommercePaymentMethod,
} from "../constants/enums.js";
import { dateMatch } from "./query-filters.js";
import {
  EcommerceOrder,
  EcommerceOrderCancellationRequest,
  EcommerceOrderReturnRequest,
} from "../models/index.js";
import { computeEcommerceCollections } from "./ecommerce-workspace-collections.js";

export const AWAITING_FULFILMENT_STATUSES = [
  EcommerceOrderStatus.PAID,
  EcommerceOrderStatus.PROCESSING,
];

export const REFUND_OUTFLOW_STATUSES = [
  EcommercePaymentExceptionRefundStatus.SUCCEEDED,
  EcommercePaymentExceptionRefundStatus.MANUAL_RECORDED,
];

export function istDateRangeMatch(field, from, to) {
  return dateMatch(field, { from, to });
}

export function sumPaise(rows, picker) {
  let total = 0;
  for (const row of rows) {
    const v = Number(picker(row) ?? 0);
    if (Number.isFinite(v) && v > 0) total += Math.trunc(v);
  }
  return total;
}

export async function countOrdersPlaced(tenantId, from, to) {
  return EcommerceOrder.countDocuments({
    tenantId,
    ...istDateRangeMatch("createdAt", from, to),
  });
}

export async function aggregateWorkspaceSummary(tenantId, from, to) {
  const tenantScope = { tenantId };
  const placedRange = istDateRangeMatch("createdAt", from, to);

  const [
    ordersPlaced,
    onlinePaidOrders,
    codPendingAcceptance,
    awaitingFulfilment,
    readyForPickup,
    shipped,
    delivered,
    openCancellationRequests,
    openReturnRequests,
    paymentExceptions,
    collections,
  ] = await Promise.all([
    EcommerceOrder.countDocuments({ ...tenantScope, ...placedRange }),
    EcommerceOrder.countDocuments({
      ...tenantScope,
      paymentMethod: EcommercePaymentMethod.ONLINE,
      paidAt: { $ne: null },
      ...placedRange,
    }),
    EcommerceOrder.countDocuments({
      ...tenantScope,
      status: EcommerceOrderStatus.COD_PENDING_ACCEPTANCE,
      ...placedRange,
    }),
    EcommerceOrder.countDocuments({
      ...tenantScope,
      status: { $in: AWAITING_FULFILMENT_STATUSES },
    }),
    EcommerceOrder.countDocuments({
      ...tenantScope,
      status: EcommerceOrderStatus.READY_FOR_PICKUP,
    }),
    EcommerceOrder.countDocuments({
      ...tenantScope,
      status: EcommerceOrderStatus.SHIPPED,
    }),
    EcommerceOrder.countDocuments({
      ...tenantScope,
      status: EcommerceOrderStatus.DELIVERED,
    }),
    EcommerceOrderCancellationRequest.countDocuments({
      ...tenantScope,
      status: {
        $in: [
          EcommerceOrderCancellationRequestStatus.PENDING_DECISION,
          EcommerceOrderCancellationRequestStatus.APPROVED_PROCESSING,
        ],
      },
    }),
    EcommerceOrderReturnRequest.countDocuments({
      ...tenantScope,
      status: {
        $in: [
          EcommerceOrderReturnRequestStatus.PENDING_REVIEW,
          EcommerceOrderReturnRequestStatus.APPROVED,
          EcommerceOrderReturnRequestStatus.RECEIVED,
          EcommerceOrderReturnRequestStatus.INSPECTED,
        ],
      },
    }),
    EcommerceOrder.countDocuments({
      ...tenantScope,
      paymentExceptionStatus: { $ne: null },
    }),
    computeEcommerceCollections(tenantId, from, to),
  ]);

  return {
    placement: {
      ordersPlaced,
      onlinePaidOrdersPlacedInPeriod: onlinePaidOrders,
      codPendingAcceptancePlacedInPeriod: codPendingAcceptance,
    },
    pipeline: {
      awaitingFulfilment,
      readyForPickup,
      shipped,
      delivered,
      openCancellationRequests,
      openReturnRequests,
      paymentExceptionsOpen: paymentExceptions,
    },
    collections,
  };
}
