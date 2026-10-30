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
  EcommercePaymentAttempt,
  EcommercePaymentExceptionRefund,
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

/**
 * Open items on the Payment exceptions page: refunds not yet finished, stuck /
 * uncertain gateway attempts, and exception orders without a completed refund.
 * (Orders keep paymentExceptionStatus after the refund succeeds, so counting that
 * field alone kept resolved cases on the dashboard forever.)
 */
export async function countOpenEcommercePaymentExceptions(tenantId) {
  const OPEN_REFUND = [
    EcommercePaymentExceptionRefundStatus.ASSIGNED,
    EcommercePaymentExceptionRefundStatus.INITIATED,
    EcommercePaymentExceptionRefundStatus.PROVIDER_PENDING,
    EcommercePaymentExceptionRefundStatus.FAILED,
  ];
  const [openRefundOrderIds, exceptionOrderIds, finishedOrderIds, stuck, uncertain] =
    await Promise.all([
      EcommercePaymentExceptionRefund.distinct("orderId", {
        tenantId,
        status: { $in: OPEN_REFUND },
      }),
      EcommerceOrder.distinct("_id", {
        tenantId,
        paymentExceptionStatus: { $ne: null },
      }),
      EcommercePaymentExceptionRefund.distinct("orderId", {
        tenantId,
        status: { $in: REFUND_OUTFLOW_STATUSES },
      }),
      EcommercePaymentAttempt.countDocuments({ tenantId, operationalStatus: "STUCK_RECONCILE" }),
      EcommercePaymentAttempt.countDocuments({ tenantId, operationalStatus: "INITIATION_UNCERTAIN" }),
    ]);
  const finished = new Set(finishedOrderIds.map(String));
  const open = new Set(openRefundOrderIds.map(String));
  for (const id of exceptionOrderIds) {
    if (!finished.has(String(id))) open.add(String(id));
  }
  return open.size + stuck + uncertain;
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
    countOpenEcommercePaymentExceptions(tenantId),
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
