import { PaymentStatus, SchemeStatus } from "../constants/enums.js";
import { Payment, Scheme } from "../models/index.js";
import { withTransaction } from "./transaction.js";

export async function expirePendingEnrolmentIfUnpaid({ tenantId, schemeId }) {
  if (!schemeId) return { expired: false };
  return withTransaction(async (session) => {
    const scheme = await Scheme.findOne({
      _id: schemeId,
      tenantId,
      status: SchemeStatus.PENDING_PAYMENT,
    }).session(session);
    if (!scheme) return { expired: false };
    const hasSuccess = await Payment.exists({
      tenantId,
      schemeId,
      status: PaymentStatus.SUCCESS,
    }).session(session);
    if (hasSuccess) return { expired: false };
    const hasPending = await Payment.exists({
      tenantId,
      schemeId,
      status: PaymentStatus.PENDING,
    }).session(session);
    if (hasPending) return { expired: false };
    scheme.status = SchemeStatus.ENROLMENT_EXPIRED;
    scheme.version += 1;
    await scheme.save({ session });
    return { expired: true, schemeId };
  });
}
