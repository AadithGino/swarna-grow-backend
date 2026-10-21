import { getReminderConfig, pushEnabledForType } from "./reminder-config.js";
import { withTransaction } from "./transaction.js";
import { Tenant } from "../models/index.js";
import { writeAudit } from "../services/audit.service.js";
import { isDuplicateKeyError, queueDigitalMetalInboxPushMessage } from "./digital-metals-inbox-queue.js";

function systemReq(tenantId, branchId) {
  return {
    auth: { id: "digital-metal-notifier", tenantId, type: "SYSTEM" },
    scope: { tenantId, branchId },
    headers: {},
    ip: "worker",
  };
}

export async function deliverDigitalMetalCustomerPushNotice({
  tenantId,
  branchId,
  customerId,
  type,
  inboxEventKey,
  templateParams,
}) {
  const tenant = await Tenant.findById(tenantId).select("settings version name displayName").lean();
  if (!tenant) return { outcome: "CUSTOMER_NOT_FOUND" };
  const config = getReminderConfig(tenant);
  if (!pushEnabledForType(config, type, templateParams ?? {})) {
    return { outcome: "NO_DELIVERY_CHANNEL" };
  }
  const req = systemReq(tenantId, branchId);
  try {
    const result = await withTransaction(async (session) => {
      const queued = await queueDigitalMetalInboxPushMessage({
        tenantId,
        branchId,
        customerId,
        type,
        inboxEventKey,
        templateParams,
        session,
      });
      if (queued.outcome === "ALREADY_NOTIFIED") {
        return queued;
      }
      await writeAudit({
        req,
        action: "MESSAGE_QUEUED",
        entityType: "MESSAGE",
        entityId: queued.messageId,
        after: queued.row,
        session,
      });
      return queued;
    });
    if (result.outcome === "QUEUED") {
      return { outcome: "QUEUED", count: 1, messageId: result.messageId };
    }
    return result;
  } catch (err) {
    if (isDuplicateKeyError(err) || isDuplicateKeyError(err?.cause)) {
      return { outcome: "ALREADY_NOTIFIED" };
    }
    const msg = String(err?.message ?? err);
    if (msg.includes("E11000") || msg.includes("duplicate key")) {
      return { outcome: "ALREADY_NOTIFIED" };
    }
    return { outcome: "QUEUE_FAILED", error: msg.slice(0, 200) };
  }
}
