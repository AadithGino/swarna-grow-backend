import { DispatchState, MessageStatus } from "../constants/enums.js";
import { env } from "../config/env.js";
import { errors } from "./app-error.js";
import { withTransientTransactionRetry } from "./transaction.js";
import { Message } from "../models/index.js";
import { writeAudit } from "../services/audit.service.js";
import {
  LogicalResendPrepareOutcome,
  prepareDeliveriesForLogicalResend,
} from "../services/push-delivery.service.js";

const MAX_LOGICAL_RESENDS = () => env.MESSAGE_LOGICAL_RESEND_MAX ?? 8;

function logicalInboxKey(row) {
  const key = row?.reminderDedupeKey ?? row?.templateParams?.inboxEventKey;
  return key && String(key).trim() ? String(key).trim() : null;
}

function messageDispatchLeaseClearable(message, now = new Date()) {
  if (!message.dispatchLeaseExpiresAt) return true;
  return message.dispatchLeaseExpiresAt <= now;
}

/** Re-dispatch an existing logical inbox row without creating a duplicate Message. */
export async function retryLogicalInboxMessageDispatch(req, original) {
  const inboxKey = logicalInboxKey(original);
  if (!inboxKey) {
    throw errors.validation([{ field: "messageId", message: "Message has no logical inbox identity." }]);
  }
  return withTransientTransactionRetry(async (session) => {
    const locked = await Message.findOne({
      _id: original._id,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!locked) throw errors.notFound("Message");
    if (logicalInboxKey(locked.toObject()) !== inboxKey) {
      throw errors.conflict("INBOX_KEY_CHANGED", "Message inbox identity changed.");
    }
    const resendCount = locked.logicalResendCount ?? 0;
    if (resendCount >= MAX_LOGICAL_RESENDS()) {
      throw errors.business(
        "LOGICAL_RESEND_LIMIT",
        "Logical resend limit reached for this inbox message.",
      );
    }

    const prep = await prepareDeliveriesForLogicalResend(
      {
        tenantId: req.auth.tenantId,
        messageId: locked._id,
        customerId: locked.customerId,
      },
      session,
    );

    const now = new Date();
    let resendOutcome = prep.outcome;
    const auditAfter = {
      inboxEventKey: inboxKey,
      channel: locked.channel,
      type: locked.type,
      resendOutcome,
      devicesRevived: prep.revived,
    };

    if (prep.outcome === LogicalResendPrepareOutcome.RETRY_SCHEDULED) {
      locked.status = MessageStatus.QUEUED;
      locked.dispatchState = DispatchState.PENDING;
      if (messageDispatchLeaseClearable(locked, now)) {
        locked.dispatchLeaseOwner = null;
        locked.dispatchLeaseExpiresAt = null;
      }
      locked.failedAt = undefined;
      locked.failureCode = undefined;
      locked.failureMessage = undefined;
      locked.logicalResendCount = resendCount + 1;
      await locked.save({ session });
    } else if (prep.outcome === LogicalResendPrepareOutcome.ALREADY_DELIVERED) {
      locked.status = MessageStatus.SENT;
      locked.dispatchState = DispatchState.DISPATCHED;
      locked.failedAt = undefined;
      locked.failureCode = undefined;
      locked.failureMessage = undefined;
      await locked.save({ session });
    } else if (prep.outcome === LogicalResendPrepareOutcome.NO_RETRY_TARGETS) {
      locked.status = MessageStatus.FAILED;
      locked.dispatchState = DispatchState.PENDING;
      locked.failureMessage = "No retryable device deliveries remain.";
      locked.failedAt = now;
      await locked.save({ session });
    } else if (prep.outcome === LogicalResendPrepareOutcome.ACTIVE_CLAIMS_ONLY) {
      resendOutcome = LogicalResendPrepareOutcome.ACTIVE_CLAIMS_ONLY;
      auditAfter.note = "Active device claims preserved; message left unchanged.";
    } else if (prep.outcome === LogicalResendPrepareOutcome.NO_DEVICES) {
      locked.status = MessageStatus.FAILED;
      locked.failureMessage = "No registered device deliveries.";
      locked.failedAt = now;
      await locked.save({ session });
    }

    await writeAudit({
      req,
      action: "MESSAGE_RESEND_RETRY",
      entityType: "MESSAGE",
      entityId: locked._id,
      after: auditAfter,
      session,
    });
    return { ...locked.toObject(), resendOutcome };
  });
}

export function messageHasLogicalInboxIdentity(row) {
  return Boolean(logicalInboxKey(row));
}
