import { errors } from './app-error.js';
import { EcommercePaymentExceptionRefund } from '../models/index.js';
import { reserveCapacityForRefundRetry } from './ecommerce-refund-allocator.js';
import { getBookingPaymentHandlers } from './ecommerce-booking-payment-handlers.js';

/** The same case is claimed by both provider initiation and manual recording. */
export async function claimManualRefund(session, { tenantId, orderId, refundId, reference, userId }) {
  const updated = await EcommercePaymentExceptionRefund.findOneAndUpdate({
    _id: refundId, tenantId, orderId,
    status: { $in: ['ASSIGNED', 'FAILED'] },
    $or: [{ status: 'FAILED' }, { providerRefundId: null }],
  }, { $set: { status: 'MANUAL_RECORDED', providerRefundId: reference, assignedUserId: userId }, $inc: { version: 1 } }, { session, new: true });
  if (!updated) throw errors.conflict('REFUND_NOT_MANUALLY_PAYABLE', 'Refund is completed or a provider outcome needs reconciliation.');
  // A FAILED row had freed its capacity, and the claim above may have just revived it. Re-check, in
  // the same transaction, that nothing else has taken that capacity; if it has, the claim rolls
  // back. For a row that was ASSIGNED the row still holds its own capacity, so the check passes.
  await reserveCapacityForRefundRetry({ tenantId, refundRow: updated.toObject?.() ?? updated, session });
  // A staff-recorded refund settles a booking-owned refund just like a provider confirmation does.
  if (updated.bookingId) {
    await getBookingPaymentHandlers().onRefundSettled({ refund: updated.toObject?.() ?? updated, session });
  }
  return updated;
}
