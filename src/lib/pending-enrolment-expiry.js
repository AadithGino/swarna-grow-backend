import { AuditEntityType, PaymentStatus, SchemeStatus } from "../constants/enums.js";
import { OutboxEvent, Payment, Scheme } from "../models/index.js";
import { withTransaction } from "./transaction.js";

async function expirePendingEnrolmentCore({ session, tenantId, schemeId, req }) {
  if (!schemeId) return { expired: false };
  const scheme = await Scheme.findOne({
    _id: schemeId,
    tenantId,
    status: SchemeStatus.PENDING_PAYMENT,
  }).session(session);
  if (!scheme) return { expired: false };
  const hasAllocatedSuccess = await Payment.exists({
    tenantId,
    schemeId,
    status: PaymentStatus.SUCCESS,
    allocatedAmountPaise: { $gt: 0 },
  }).session(session);
  if (hasAllocatedSuccess) return { expired: false, reason: "ALLOCATED_SUCCESS" };
  const hasPending = await Payment.exists({
    tenantId,
    schemeId,
    status: PaymentStatus.PENDING,
  }).session(session);
  if (hasPending) return { expired: false, reason: "PENDING_PAYMENT" };
  scheme.status = SchemeStatus.ENROLMENT_EXPIRED;
  scheme.version += 1;
  await scheme.save({ session });
  await OutboxEvent.create(
    [
      {
        tenantId,
        topic: "scheme.enrolment.expired",
        key: scheme._id,
        payload: {
          schemeId: scheme._id,
          customerId: scheme.customerId,
          branchId: scheme.branchId,
          planId: scheme.planId,
        },
      },
    ],
    { session },
  );
  if (req) {
    const { writeAudit } = await import("../services/audit.service.js");
    await writeAudit({
      req,
      action: "SCHEME_ENROLMENT_EXPIRED",
      entityType: AuditEntityType.SCHEME,
      entityId: scheme._id,
      after: scheme.toObject(),
      session,
    });
  }
  return { expired: true, schemeId: scheme._id };
}

export async function expirePendingEnrolmentInSession({ session, tenantId, schemeId, req }) {
  return expirePendingEnrolmentCore({ session, tenantId, schemeId, req });
}

export async function expirePendingEnrolmentIfUnpaid({ tenantId, schemeId, req }) {
  if (!schemeId) return { expired: false };
  return withTransaction(async (session) =>
    expirePendingEnrolmentCore({ session, tenantId, schemeId, req }),
  );
}
