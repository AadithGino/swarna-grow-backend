import { errors } from "./app-error.js";

const closed = new Set(["SUCCEEDED", "MANUAL_RECORDED"]);

/** Order URLs remain compatible; mutations must identify the case when there are several captures. */
export async function selectOrderRefund(Model, req, orderId, { mutation = false, session = null } = {}) {
  const rows = await Model.find({ tenantId: req.auth.tenantId, orderId })
    .sort({ createdAt: 1, _id: 1 }).session(session).lean();
  const refundId = req.body?.refundId ?? req.query?.refundId;
  if (refundId) {
    const refund = rows.find(row => String(row._id) === String(refundId));
    if (!refund) throw errors.notFound("Refund case");
    return { refund, refunds: rows };
  }
  if (mutation && rows.length > 1) {
    throw errors.conflict("REFUND_CASE_REQUIRED", "Choose the specific refund case before continuing.");
  }
  return { refund: rows.find(row => !closed.has(row.status)) ?? rows.at(-1) ?? null, refunds: rows };
}
