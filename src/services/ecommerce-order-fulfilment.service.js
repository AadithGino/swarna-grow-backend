import { assertLinkedSchemeBacking, settleLinkedOrderHold, updateOrderRedemption } from "./ecommerce-scheme-reservation.service.js";
import { loadEcommerceOrderForAdmin } from "../lib/ecommerce-admin-order-scope.js";
import { consumeOrderStockReservationsOnce, releaseOrderReservationsOnce } from "../lib/ecommerce-order-lifecycle.js";
import { createId } from "../lib/ids.js";
import { errors } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { assertEcommerceOrderTransition } from "../lib/ecommerce-order-transitions.js";
import {
  EcommerceFulfilmentMode,
  EcommerceOrderEventType,
  EcommerceOrderStatus,
} from "../constants/enums.js";
import { EcommerceOrder, EcommerceOrderEvent } from "../models/index.js";
import {
  ECOMMERCE_OUTBOX_TOPICS,
  enqueueEcommerceOutboxEvent,
} from "../lib/ecommerce-commerce-outbox.js";
import { assertDeliveryTrackingForShipped } from "./ecommerce-order-delivery.service.js";
import { assertFulfilmentHandoverBeforeDelivered } from "./ecommerce-order-handover.service.js";

const BLOCKED_FOR_FULFILMENT = new Set([
  EcommerceOrderStatus.PENDING_PAYMENT,
  EcommerceOrderStatus.PAYMENT_EXPIRED,
  EcommerceOrderStatus.PAYMENT_FAILED,
  EcommerceOrderStatus.COD_PENDING_ACCEPTANCE,
]);

function assertFulfilmentSnapshot(order, targetStatus) {
  if (order.fulfilmentMode === EcommerceFulfilmentMode.BRANCH_PICKUP) {
    if (!order.pickupBranchId) {
      throw errors.business("FULFILMENT_INVALID", "Pickup branch is missing on the order.");
    }
  }
  if (order.fulfilmentMode === EcommerceFulfilmentMode.DELIVERY) {
    const pin = order.addressSnapshot?.pincode ?? order.addressSnapshot?.postalCode;
    if (!pin) {
      throw errors.business("FULFILMENT_INVALID", "Delivery address snapshot is incomplete.");
    }
  }
  if (
    targetStatus === EcommerceOrderStatus.READY_FOR_PICKUP
    && order.fulfilmentMode !== EcommerceFulfilmentMode.BRANCH_PICKUP
  ) {
    throw errors.business("FULFILMENT_INVALID", "Ready for pickup applies to branch pickup orders only.");
  }
  if (
    targetStatus === EcommerceOrderStatus.SHIPPED
    && order.fulfilmentMode !== EcommerceFulfilmentMode.DELIVERY
  ) {
    throw errors.business("FULFILMENT_INVALID", "Shipped applies to delivery orders only.");
  }
}

export async function transitionAdminOrderFulfilment(req) {
  const targetStatus = String(req.body.targetStatus ?? "").trim();
  const expectedVersion = Number(req.body.expectedVersion);
  if (!targetStatus) {
    throw errors.validation([{ field: "targetStatus", message: "targetStatus is required." }]);
  }
  if (!Number.isInteger(expectedVersion)) {
    throw errors.validation([{ field: "expectedVersion", message: "expectedVersion is required." }]);
  }

  return withTransaction(async (session) => {
    const order = await loadEcommerceOrderForAdmin(req, req.params.orderId, { session, lean: false });
    if (!order) throw errors.notFound("Order");
    if (order.paymentExceptionStatus) {
      throw errors.business("FULFILMENT_BLOCKED", "Orders with payment exceptions cannot be fulfilled.");
    }
    if (order.activeCancellationRequestId) {
      throw errors.business(
        "FULFILMENT_BLOCKED",
        "Resolve the open cancellation request before updating fulfilment.",
      );
    }
    const purchase = order.financialSnapshot?.schemePurchase;
    if (purchase?.approvalStatus === "PENDING" && order.status === EcommerceOrderStatus.PENDING_PAYMENT &&
        [EcommerceOrderStatus.PAID, EcommerceOrderStatus.CANCELLED].includes(targetStatus)) {
      if (expectedVersion !== order.version) throw errors.conflict("VERSION_CONFLICT", "Order changed. Refresh and retry.");
      if (new Date(order.expiresAt) <= new Date()) throw errors.business("SCHEME_ORDER_EXPIRED", "The scheme purchase window expired.");
      const approved = targetStatus === EcommerceOrderStatus.PAID;
      const fullyCovered = approved && order.totalPaise === 0;
      const key = { tenantId: order.tenantId, orderId: order._id, session };
      if (!approved) {
        await settleLinkedOrderHold(order, "RELEASED", session);
        await releaseOrderReservationsOnce(key);
      } else {
        await assertLinkedSchemeBacking(order, session);
        await updateOrderRedemption(order, "APPROVED", session, req.auth.id);
        if (fullyCovered) await consumeOrderStockReservationsOnce(key);
      }
      const updated = await EcommerceOrder.findOneAndUpdate(
        { _id: order._id, tenantId: order.tenantId },
        { $set: {
          status: approved ? (fullyCovered ? EcommerceOrderStatus.PAID : EcommerceOrderStatus.PENDING_PAYMENT)
            : EcommerceOrderStatus.CANCELLED,
          "financialSnapshot.schemePurchase.approvalStatus": approved ? "APPROVED" : "REJECTED",
          "financialSnapshot.schemePurchase.decidedBy": req.auth.id,
          "financialSnapshot.schemePurchase.decidedAt": new Date(),
          ...(fullyCovered ? { paidAt: new Date() } : {}),
        }, $inc: { version: 1 } },
        { session, new: true },
      );
      await EcommerceOrderEvent.create([{
        _id: createId("eoev"), tenantId: order.tenantId, orderId: order._id,
        type: EcommerceOrderEventType.FULFILMENT_UPDATED, actorType: "STAFF", actorId: req.auth.id,
        payload: { schemeApproval: approved ? "APPROVED" : "REJECTED", from: order.status, to: updated.status },
      }], { session });
      return updated.toObject();
    }
    if (targetStatus === EcommerceOrderStatus.CANCELLED) {
      throw errors.business(
        "USE_CANCELLATION_FLOW",
        "Use the dedicated cancellation workflow instead of fulfilment transition.",
      );
    }
    if (BLOCKED_FOR_FULFILMENT.has(order.status)) {
      throw errors.business("FULFILMENT_BLOCKED", "Order is not paid.", { status: order.status });
    }
    const allowedFulfilmentStatuses = new Set([
      EcommerceOrderStatus.PAID,
      EcommerceOrderStatus.PROCESSING,
      EcommerceOrderStatus.READY_FOR_PICKUP,
      EcommerceOrderStatus.SHIPPED,
    ]);
    if (!allowedFulfilmentStatuses.has(order.status)) {
      throw errors.business("FULFILMENT_BLOCKED", "Order status does not allow fulfilment updates.", {
        status: order.status,
      });
    }
    if (Number(order.version ?? 0) !== expectedVersion) {
      throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");
    }
    assertFulfilmentSnapshot(order.toObject(), targetStatus);
    assertEcommerceOrderTransition("STAFF", order.status, targetStatus);
    if (targetStatus === EcommerceOrderStatus.DELIVERED) {
      assertFulfilmentHandoverBeforeDelivered(order.toObject());
      await settleLinkedOrderHold(order, "CONSUMED", session, req.auth.id);
    }
    if ([EcommerceOrderStatus.SHIPPED, EcommerceOrderStatus.READY_FOR_PICKUP].includes(targetStatus)) {
      await assertLinkedSchemeBacking(order, session);
    }
    if (targetStatus === EcommerceOrderStatus.SHIPPED) {
      await assertDeliveryTrackingForShipped({
        tenantId: req.auth.tenantId,
        orderId: order._id,
        session,
      });
    }

    const fulfilmentSet = { status: targetStatus };
    if (
      targetStatus === EcommerceOrderStatus.DELIVERED
      && order.fulfilmentMode === EcommerceFulfilmentMode.DELIVERY
      && !order.deliveryTracking?.deliveredAt
    ) {
      fulfilmentSet["deliveryTracking.deliveredAt"] =
        order.fulfilmentHandover?.recordedAt ?? new Date();
    }
    const updated = await EcommerceOrder.findOneAndUpdate(
      {
        _id: order._id,
        tenantId: req.auth.tenantId,
        version: expectedVersion,
      },
      {
        $set: fulfilmentSet,
        $inc: { version: 1 },
      },
      { session, new: true },
    );
    if (!updated) throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");

    await EcommerceOrderEvent.create(
      [
        {
          _id: createId("eoev"),
          tenantId: req.auth.tenantId,
          orderId: order._id,
          type: EcommerceOrderEventType.FULFILMENT_UPDATED,
          actorType: "STAFF",
          actorId: req.auth.id,
          payload: { from: order.status, to: targetStatus },
        },
      ],
      { session },
    );
    await enqueueEcommerceOutboxEvent({
      tenantId: req.auth.tenantId,
      topic: ECOMMERCE_OUTBOX_TOPICS.FULFILMENT_MILESTONE,
      key: `${order._id}:${targetStatus}`,
      payload: {
        orderId: order._id,
        status: targetStatus,
        fulfilmentMode: order.fulfilmentMode,
      },
      session,
    });
    return updated.toObject();
  });
}
