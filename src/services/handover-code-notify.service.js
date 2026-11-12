import { MessageType } from "../constants/enums.js";
import { Customer, Tenant } from "../models/index.js";
import {
  CustomerSocketEvent,
  emitToCustomer,
} from "../realtime/customer-socket.js";
import { queueCustomerNotification } from "./customer-notification.service.js";
import { logger } from "../config/logger.js";

/**
 * Push (no code in body) + socket event for counter handover codes.
 * Socket payload intentionally omits the plaintext code — client must call reveal API.
 */
export async function notifyHandoverCodeReleased({
  kind,
  tenantId,
  branchId = null,
  customerId,
  title,
  body,
  deepLink,
  entity,
}) {
  const socketEvent =
    kind === "REDEMPTION_OTP"
      ? CustomerSocketEvent.REDEMPTION_HANDOVER_OTP_RELEASED
      : CustomerSocketEvent.SHOP_PICKUP_CODE_RELEASED;

  const socketPayload = {
    kind,
    deepLink,
    expiresAt: entity.expiresAt ? new Date(entity.expiresAt).toISOString() : null,
    ...(kind === "REDEMPTION_OTP"
      ? {
          redemptionId: entity.redemptionId,
          schemeId: entity.schemeId ?? null,
        }
      : {
          orderId: entity.orderId,
          orderNumber: entity.orderNumber ?? null,
        }),
  };

  emitToCustomer(tenantId, customerId, socketEvent, socketPayload);

  try {
    const customer = await Customer.findOne({ _id: customerId, tenantId })
      .select("mobile whatsappOptedOutAt")
      .lean();
    if (!customer) return { socket: true, push: "CUSTOMER_NOT_FOUND" };

    const type =
      kind === "REDEMPTION_OTP"
        ? MessageType.SCHEME_REDEMPTION_HANDOVER_OTP
        : MessageType.ECOMMERCE_PICKUP_CODE_RELEASED;

    const inboxEventKey =
      kind === "REDEMPTION_OTP"
        ? `redemption.handover-otp:${entity.redemptionId}:${entity.releasedAtIso ?? entity.expiresAt}`
        : `ecommerce.pickup-code:${entity.orderId}:${entity.releasedAtIso ?? entity.expiresAt}`;

    const result = await queueCustomerNotification({
      tenantId,
      branchId: branchId ?? null,
      customerId,
      schemeId: entity.schemeId ?? null,
      type,
      pushOnly: true,
      customer,
      templateParams: {
        inboxEventKey,
        title,
        body,
        deepLink,
        redemptionId: entity.redemptionId ?? "",
        orderId: entity.orderId ?? "",
        orderNumber: entity.orderNumber ?? "",
        expiresAt: entity.expiresAt ? new Date(entity.expiresAt).toISOString() : "",
      },
    });
    return {
      socket: true,
      push: result.queued?.length ? "QUEUED" : "NO_DELIVERY_CHANNEL",
      messageIds: (result.queued ?? []).map((m) => m._id),
    };
  } catch (err) {
    logger.warn({ err, tenantId, customerId, kind }, "Handover code push notify failed");
    return { socket: true, push: "ERROR", error: err.message };
  }
}

export async function tenantDisplayName(tenantId) {
  const t = await Tenant.findById(tenantId).select("name displayName").lean();
  return t?.displayName || t?.name || "Your jeweller";
}
