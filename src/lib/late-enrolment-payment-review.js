import { Alert } from "../models/index.js";
import { OutboxEvent } from "../models/index.js";
import { SchemeStatus } from "../constants/enums.js";

/** Idempotent suspense routing when gateway success arrives after enrolment expired. */
export async function recordLateSuccessOnExpiredEnrolment({
  session,
  tenantId,
  scheme,
  payment,
}) {
  if (!scheme || scheme.status !== SchemeStatus.ENROLMENT_EXPIRED) return { recorded: false };
  await Alert.findOneAndUpdate(
    {
      tenantId,
      type: "PAYMENT_REVIEW",
      entityId: payment._id,
      status: "OPEN",
    },
    {
      $setOnInsert: {
        branchId: payment.branchId ?? scheme.branchId,
        severity: "CRITICAL",
        title: "Late payment after enrolment expired",
        message:
          "A gateway payment succeeded after the pending enrolment expired. Funds require manual review and suspense allocation.",
        entityType: "PAYMENT",
        metadata: {
          schemeId: scheme._id,
          customerId: scheme.customerId,
          paymentId: payment._id,
          reason: "LATE_SUCCESS_ENROLMENT_EXPIRED",
        },
      },
    },
    { upsert: true, session },
  );
  try {
    await OutboxEvent.create(
      [
        {
          tenantId,
          topic: "payment.unallocated.enrolment_expired",
          key: payment._id,
          payload: {
            paymentId: payment._id,
            schemeId: scheme._id,
            customerId: scheme.customerId,
            branchId: payment.branchId ?? scheme.branchId,
          },
        },
      ],
      { session },
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
  return { recorded: true };
}
