import { createId } from "../lib/ids.js";
import { errors } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import {
  consumeOrderStockReservationsOnce,
  releaseOrderReservationsOnce,
} from "../lib/ecommerce-order-lifecycle.js";
import { orderUsesCod } from "../lib/ecommerce-cod.js";
import {
  EcommerceOrderEventType,
  EcommerceOrderStatus,
  EcommerceStockReleaseReason,
} from "../constants/enums.js";
import { EcommerceOrder, EcommerceOrderEvent } from "../models/index.js";
import {
  ECOMMERCE_OUTBOX_TOPICS,
  enqueueEcommerceOutboxEvent,
} from "../lib/ecommerce-commerce-outbox.js";

function assertCodOrder(order) {
  if (!orderUsesCod(order)) {
    throw errors.business("NOT_COD_ORDER", "Order is not a cash-on-delivery order.");
  }
}

export async function acceptAdminCodOrder(req) {
  const expectedVersion = Number(req.body.expectedVersion);
  if (!Number.isInteger(expectedVersion)) {
    throw errors.validation([{ field: "expectedVersion", message: "expectedVersion is required." }]);
  }
  return withTransaction(async (session) => {
    const order = await EcommerceOrder.findOne({
      _id: req.params.orderId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!order) throw errors.notFound("Order");
    assertCodOrder(order.toObject());
    if (order.status !== EcommerceOrderStatus.COD_PENDING_ACCEPTANCE) {
      throw errors.business("COD_ACCEPTANCE_INVALID", "Order is not awaiting COD acceptance.", {
        status: order.status,
      });
    }
    if (Number(order.version ?? 0) !== expectedVersion) {
      throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");
    }
    if (order.expiresAt && new Date(order.expiresAt) <= new Date()) {
      throw errors.business("COD_ACCEPTANCE_EXPIRED", "COD acceptance window has expired.");
    }

    const updated = await EcommerceOrder.findOneAndUpdate(
      {
        _id: order._id,
        tenantId: req.auth.tenantId,
        version: expectedVersion,
        status: EcommerceOrderStatus.COD_PENDING_ACCEPTANCE,
      },
      {
        $set: { status: EcommerceOrderStatus.PROCESSING },
        $inc: { version: 1 },
      },
      { session, new: true },
    );
    if (!updated) throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");

    await consumeOrderStockReservationsOnce({
      tenantId: req.auth.tenantId,
      orderId: order._id,
      session,
    });

    await EcommerceOrderEvent.create(
      [
        {
          _id: createId("eoev"),
          tenantId: req.auth.tenantId,
          orderId: order._id,
          type: EcommerceOrderEventType.COD_ACCEPTED,
          actorType: "STAFF",
          actorId: req.auth.id,
          payload: { from: EcommerceOrderStatus.COD_PENDING_ACCEPTANCE, to: EcommerceOrderStatus.PROCESSING },
        },
      ],
      { session },
    );
    await enqueueEcommerceOutboxEvent({
      tenantId: req.auth.tenantId,
      topic: ECOMMERCE_OUTBOX_TOPICS.ORDER_UPDATED,
      key: `${order._id}:cod-accepted`,
      payload: { orderId: order._id, kind: "COD_ACCEPTED" },
      session,
    });
    return updated.toObject();
  });
}

export async function rejectAdminCodOrder(req) {
  const expectedVersion = Number(req.body.expectedVersion);
  if (!Number.isInteger(expectedVersion)) {
    throw errors.validation([{ field: "expectedVersion", message: "expectedVersion is required." }]);
  }
  const reason = String(req.body.reason ?? "").trim().slice(0, 500);
  return withTransaction(async (session) => {
    const order = await EcommerceOrder.findOne({
      _id: req.params.orderId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!order) throw errors.notFound("Order");
    assertCodOrder(order.toObject());
    if (order.status !== EcommerceOrderStatus.COD_PENDING_ACCEPTANCE) {
      throw errors.business("COD_ACCEPTANCE_INVALID", "Order is not awaiting COD acceptance.", {
        status: order.status,
      });
    }
    if (Number(order.version ?? 0) !== expectedVersion) {
      throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");
    }

    const updated = await EcommerceOrder.findOneAndUpdate(
      {
        _id: order._id,
        tenantId: req.auth.tenantId,
        version: expectedVersion,
        status: EcommerceOrderStatus.COD_PENDING_ACCEPTANCE,
      },
      {
        $set: {
          status: EcommerceOrderStatus.CANCELLED,
          stockReleaseReason: EcommerceStockReleaseReason.COD_REJECTED,
          stockReleasedAt: new Date(),
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    );
    if (!updated) throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");

    await releaseOrderReservationsOnce({
      tenantId: req.auth.tenantId,
      orderId: order._id,
      session,
    });

    await EcommerceOrderEvent.create(
      [
        {
          _id: createId("eoev"),
          tenantId: req.auth.tenantId,
          orderId: order._id,
          type: EcommerceOrderEventType.COD_REJECTED,
          actorType: "STAFF",
          actorId: req.auth.id,
          payload: { reason: reason || null },
        },
      ],
      { session },
    );
    await enqueueEcommerceOutboxEvent({
      tenantId: req.auth.tenantId,
      topic: ECOMMERCE_OUTBOX_TOPICS.ORDER_UPDATED,
      key: `${order._id}:cod-rejected`,
      payload: { orderId: order._id, kind: "COD_REJECTED" },
      session,
    });
    return updated.toObject();
  });
}

