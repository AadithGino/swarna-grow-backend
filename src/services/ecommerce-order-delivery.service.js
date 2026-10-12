import { createId } from "../lib/ids.js";
import { errors } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import {
  EcommerceFulfilmentMode,
  EcommerceOrderEventType,
  EcommerceOrderStatus,
} from "../constants/enums.js";
import { EcommerceFulfilmentSettings, EcommerceOrder, EcommerceOrderEvent } from "../models/index.js";

const TRACKING_URL_RE = /^https:\/\/[^\s]+$/i;

function mapTracking(row) {
  const t = row?.deliveryTracking ?? {};
  return {
    carrierName: t.carrierName ?? "",
    trackingNumber: t.trackingNumber ?? "",
    trackingUrl: t.trackingUrl ?? "",
    dispatchedAt: t.dispatchedAt ?? null,
    deliveredAt: t.deliveredAt ?? null,
  };
}

export async function patchAdminOrderDeliveryTracking(req) {
  const expectedVersion = Number(req.body.expectedVersion);
  if (!Number.isInteger(expectedVersion)) {
    throw errors.validation([{ field: "expectedVersion", message: "expectedVersion is required." }]);
  }
  const carrierName = String(req.body.carrierName ?? "").trim().slice(0, 120);
  const trackingNumber = String(req.body.trackingNumber ?? "").trim().slice(0, 80);
  const trackingUrl = String(req.body.trackingUrl ?? "").trim().slice(0, 500);
  if (trackingUrl && !TRACKING_URL_RE.test(trackingUrl)) {
    throw errors.validation([{ field: "trackingUrl", message: "Tracking URL must be https." }]);
  }
  const dispatchedAt = req.body.dispatchedAt ? new Date(req.body.dispatchedAt) : undefined;
  if (req.body.deliveredAt != null) {
    throw errors.validation([
      {
        field: "deliveredAt",
        message: "Delivery completion time is set when handover proof is recorded and the order is marked delivered.",
      },
    ]);
  }

  return withTransaction(async (session) => {
    const order = await EcommerceOrder.findOne({
      _id: req.params.orderId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!order) throw errors.notFound("Order");
    if (order.fulfilmentMode !== EcommerceFulfilmentMode.DELIVERY) {
      throw errors.business("NOT_DELIVERY_ORDER", "Courier tracking applies to delivery orders only.");
    }
    if (Number(order.version ?? 0) !== expectedVersion) {
      throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");
    }
    const updated = await EcommerceOrder.findOneAndUpdate(
      { _id: order._id, tenantId: req.auth.tenantId, version: expectedVersion },
      {
        $set: {
          deliveryTracking: {
            carrierName,
            trackingNumber,
            trackingUrl,
            dispatchedAt: dispatchedAt ?? order.deliveryTracking?.dispatchedAt ?? null,
            deliveredAt: order.deliveryTracking?.deliveredAt ?? null,
          },
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    );
    await EcommerceOrderEvent.create(
      [
        {
          _id: createId("eoev"),
          tenantId: req.auth.tenantId,
          orderId: order._id,
          type: EcommerceOrderEventType.FULFILMENT_UPDATED,
          actorType: "STAFF",
          actorId: req.auth.id,
          payload: { deliveryTrackingUpdated: true },
        },
      ],
      { session },
    );
    return { orderId: updated._id, deliveryTracking: mapTracking(updated), version: updated.version };
  });
}

export async function assertDeliveryTrackingForShipped({ tenantId, orderId, session }) {
  const order = await EcommerceOrder.findOne({ _id: orderId, tenantId }).session(session).lean();
  if (!order) return;
  if (order.fulfilmentMode !== EcommerceFulfilmentMode.DELIVERY) return;
  if (order.status === EcommerceOrderStatus.SHIPPED) return;
  const settings = await EcommerceFulfilmentSettings.findOne({ tenantId }).session(session).lean();
  if (!settings?.requireCourierTrackingForShipped) return;
  const t = order.deliveryTracking ?? {};
  const hasTracking = Boolean(String(t.trackingNumber ?? "").trim() || String(t.carrierName ?? "").trim());
  if (!hasTracking) {
    throw errors.business(
      "DELIVERY_TRACKING_REQUIRED",
      "Enter courier or tracking details before marking this delivery order shipped, or disable the requirement in fulfilment settings.",
    );
  }
}

export { mapTracking as mapOrderDeliveryTracking };
