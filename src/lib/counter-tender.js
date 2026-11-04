import { errors } from './app-error.js';
import { postCounterCash } from './counter-trade.js';

/** Recover from the immutable tender stored with the order, never retry input. */
export function assertCounterTenderReplay(order, req) {
  const original = order.assisted;
  if (!original || original.paymentMode !== req.body.paymentMode
    || String(original.paymentReference ?? '').trim() !== String(req.body.paymentReference ?? '').trim()
    || String(original.byUserId) !== String(req.auth.id)) {
    throw errors.conflict('IDEMPOTENCY_KEY_REUSED', 'This counter order was recorded with a different tender or operator.');
  }
}

export async function postAssistedOrderCash(session, order, sourceType) {
  const tender = order.assisted;
  if (!tender || tender.paymentMode !== 'CASH') return null;
  if (!tender.byUserId || !tender.byRole) throw errors.conflict('COUNTER_TENDER_INVALID', 'Counter tender needs review.');
  return postCounterCash(session, {
    req: { auth: { tenantId: order.tenantId, id: tender.byUserId, role: tender.byRole }, scope: { branchId: tender.branchId } },
    customer: { branchId: tender.branchId }, direction: 'CREDIT',
    amountPaise: order.totalPayablePaise ?? order.totalPaise,
    sourceType, sourceId: order._id, reason: `Counter payment ${order._id}`,
  });
}
