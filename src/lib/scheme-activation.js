import { SchemeStatus } from "../constants/enums.js";
import { OutboxEvent } from "../models/index.js";

export function schemeStatusesBlockingActivation() {
  return [SchemeStatus.PENDING_PAYMENT];
}

export async function activateSchemeAfterAllocatedFirstPayment({
  scheme,
  payment,
  session,
  req,
}) {
  if (scheme.status !== SchemeStatus.PENDING_PAYMENT) return { activated: false };
  if (!payment || payment.status !== "SUCCESS" || !(payment.allocatedAmountPaise > 0)) {
    return { activated: false };
  }
  scheme.status = SchemeStatus.ACTIVE;
  scheme.version += 1;
  await scheme.save({ session });
  await OutboxEvent.create(
    [
      {
        tenantId: scheme.tenantId,
        topic: "scheme.joined",
        key: scheme._id,
        payload: {
          schemeId: scheme._id,
          customerId: scheme.customerId,
          branchId: scheme.branchId,
          paymentId: payment._id,
        },
      },
    ],
    { session },
  );
  if (req) {
    const { writeAudit } = await import("../services/audit.service.js");
    const { AuditEntityType } = await import("../constants/enums.js");
    await writeAudit({
      req,
      action: "SCHEME_ACTIVATED",
      entityType: AuditEntityType.SCHEME,
      entityId: scheme._id,
      after: scheme.toObject(),
      metadata: { paymentId: payment._id, reason: "FIRST_PAYMENT_ALLOCATED" },
      session,
    });
  }
  return { activated: true };
}
