import { MessageStatus } from "../constants/enums.js";
import { createId } from "../lib/ids.js";
import { dispatchPriorityForMessageType } from "../lib/message-dispatch-priority.js";
import {
  getReminderConfig,
  pushEnabledForType,
  whatsAppEnabledForType,
} from "../lib/reminder-config.js";
import { withTransaction } from "../lib/transaction.js";
import { Message, Tenant } from "../models/index.js";
import { writeAudit } from "./audit.service.js";
import { queueMessage } from "./messaging.service.js";

function systemReq(tenantId, branchId) {
  return {
    auth: { id: "notification-dispatcher", tenantId, type: "SYSTEM" },
    scope: { tenantId, branchId },
    headers: {},
    ip: "worker",
  };
}

async function queuePushOnly(req, payload, session) {
  const message = (
    await Message.create(
      [
        {
          _id: createId("message"),
          tenantId: req.auth.tenantId,
          branchId: payload.branchId ?? req.scope?.branchId ?? null,
          status: MessageStatus.QUEUED,
          channel: "PUSH",
          dispatchPriority: dispatchPriorityForMessageType(payload.type),
          ...payload,
        },
      ],
      { session },
    )
  )[0];
  return message;
}

/** Queue WhatsApp and/or push based on tenant reminder config. */
export async function queueCustomerNotification({
  tenantId,
  branchId,
  customerId,
  schemeId,
  type,
  templateKey,
  templateParams,
  pushOnly = false,
  customer = null,
}) {
  const tenant = await Tenant.findById(tenantId).select("settings version name displayName").lean();
  if (!tenant) return { queued: [] };
  const config = getReminderConfig(tenant);
  const req = systemReq(tenantId, branchId);
  const base = {
    branchId,
    customerId,
    schemeId,
    type,
    templateKey: templateKey ?? type,
    templateParams: templateParams ?? {},
  };
  const queued = [];

  const whatsappOptedOut = Boolean(customer?.whatsappOptedOutAt);
  if (
    !pushOnly
    && !whatsappOptedOut
    && whatsAppEnabledForType(config, type)
  ) {
    queued.push(
      await queueMessage(req, { ...base, channel: "WHATSAPP" }),
    );
  }
  if (pushEnabledForType(config, type, templateParams ?? {})) {
    await withTransaction(async (session) => {
      const row = await queuePushOnly(req, base, session);
      await writeAudit({
        req,
        action: "MESSAGE_QUEUED",
        entityType: "MESSAGE",
        entityId: row._id,
        after: row.toObject(),
        session,
      });
      queued.push(row.toObject());
    });
  }
  return { queued };
}
