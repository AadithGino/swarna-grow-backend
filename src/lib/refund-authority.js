import { errors } from "./app-error.js";
import { Payment, PaymentRefund } from "../models/index.js";

/**
 * Load a gateway payment after tenant (and optional branch) scope validation.
 * Off-branch or cross-tenant resources return 404.
 */
export async function loadBranchScopedPayment(req, { session = null } = {}) {
  let query = Payment.findOne({
    _id: req.params.paymentId,
    tenantId: req.auth.tenantId,
    ...(req.scope.branchId ? { branchId: req.scope.branchId } : {}),
  });
  if (session) query = query.session(session);
  const payment = await query;
  if (!payment) throw errors.notFound("Payment");
  return payment;
}

/** Payment scope first; refund only after payment passes branch/tenant checks. */
export async function loadBranchScopedPaymentRefund(req, { session = null } = {}) {
  const payment = await loadBranchScopedPayment(req, { session });
  let query = PaymentRefund.findOne({
    _id: req.params.refundId,
    tenantId: req.auth.tenantId,
    paymentId: payment._id,
  });
  if (session) query = query.session(session);
  const refund = await query.lean();
  if (!refund) throw errors.notFound("Refund");
  return { payment, refund };
}
