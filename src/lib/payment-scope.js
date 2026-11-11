import { Customer, Payment, PaymentLink } from "../models/index.js";
import { PaymentSource, TenantRole } from "../constants/enums.js";
import { effectiveScope } from "./query-filters.js";

/** Branch staff/agents: include legacy payments with null branchId when the customer belongs to the branch. */
export async function paymentListScope(req) {
  const tenantId = req.auth.tenantId;
  if (req.auth?.role === TenantRole.COLLECTION_AGENT) {
    return { tenantId };
  }
  const branchId = effectiveScope(req).branchId;
  if (!branchId) return { tenantId };
  const customerIds = await Customer.find({ tenantId, branchId }).distinct("_id");
  if (!customerIds.length) return { tenantId, branchId };
  return {
    tenantId,
    $or: [
      { branchId },
      { branchId: null, customerId: { $in: customerIds } },
      { branchId: { $exists: false }, customerId: { $in: customerIds } },
    ],
  };
}

/**
 * Collection agents own: (1) payments with collectedBy = them, and
 * (2) gateway payments from payment-links they created (QR / share link) even if
 * collectedBy was never stamped (legacy PhonePe initiate path).
 */
export async function agentCollectedPaymentMatch(req) {
  if (req.auth?.role !== TenantRole.COLLECTION_AGENT) return {};
  const staffId = req.auth.id;
  const tenantId = req.auth.tenantId;
  const linkRows = await PaymentLink.find({
    tenantId,
    createdBy: staffId,
    paymentId: { $exists: true, $nin: [null, ""] },
  })
    .select("paymentId")
    .lean();
  const linkPaymentIds = [
    ...new Set(
      linkRows
        .map((row) => row.paymentId)
        .filter((id) => id && !String(id).startsWith("CLAIMING-")),
    ),
  ];
  if (linkPaymentIds.length) {
    await Payment.updateMany(
      {
        _id: { $in: linkPaymentIds },
        tenantId,
        $or: [{ collectedBy: null }, { collectedBy: { $exists: false } }],
      },
      { $set: { collectedBy: staffId, source: PaymentSource.STAFF_APP } },
    );
  }
  if (!linkPaymentIds.length) return { collectedBy: staffId };
  return {
    $or: [{ collectedBy: staffId }, { _id: { $in: linkPaymentIds } }],
  };
}

/** Cash totals for a staff member: custody follows collectedBy, not payment.branchId (scheme branch may differ). */
export function cashPaymentBranchMatch(branchId, staffId) {
  if (staffId) return {};
  if (!branchId) return {};
  return { branchId };
}

/** Branch stamped on new payments: desk / customer branch, not scheme.enrollment branch. */
export function resolvePaymentBranchId(req, scheme, customer) {
  return req.scope?.branchId ?? customer?.branchId ?? scheme.branchId ?? null;
}

export function paymentRecordedByLabel(payment, collector) {
  const source = String(payment?.source ?? "");
  const name = collector?.name ? String(collector.name) : null;
  if (source === "CUSTOMER_APP") return "Customer app";
  if (source === "STAFF_APP") return name ? `Staff · ${name}` : "Staff collection";
  if (source === "PORTAL") return name ? `Admin · ${name}` : "Admin panel";
  if (source === "WEBHOOK" || source === "SYSTEM") return "Online payment";
  return name ? name : "—";
}
