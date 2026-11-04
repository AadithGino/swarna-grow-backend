import { errors } from './app-error.js';
import { EcommercePaymentExceptionRefund } from '../models/index.js';

/** The same case is claimed by both provider initiation and manual recording. */
export async function claimManualRefund(session, { tenantId, orderId, refundId, reference, userId }) {
  const updated = await EcommercePaymentExceptionRefund.findOneAndUpdate({
    _id: refundId, tenantId, orderId,
    status: { $in: ['ASSIGNED', 'FAILED'] },
    $or: [{ status: 'FAILED' }, { providerRefundId: null }],
  }, { $set: { status: 'MANUAL_RECORDED', providerRefundId: reference, assignedUserId: userId }, $inc: { version: 1 } }, { session, new: true });
  if (!updated) throw errors.conflict('REFUND_NOT_MANUALLY_PAYABLE', 'Refund is completed or a provider outcome needs reconciliation.');
  return updated;
}
