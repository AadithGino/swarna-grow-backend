import { SchemeStatus } from "../constants/enums.js";
import { EcommerceSchemeReservation, EcommerceOrder, Scheme } from "../models/index.js";
import { errors } from "../lib/app-error.js";
import { adminCancellationEligible } from "../lib/ecommerce-order-cancellation-policy.js";
import { assertLinkedSchemeBacking } from "./ecommerce-scheme-reservation.service.js";
import { adminInitiateCancellation } from "./ecommerce-order-cancellation.service.js";
import { withTransaction } from "../lib/transaction.js";

const RELEASE_ELIGIBLE_STATUSES = new Set([
  "PENDING_PAYMENT",
  "PAID",
  "PROCESSING",
  "READY_FOR_PICKUP",
]);

/**
 * Cancel a scheme-backed order when the enrolment can no longer back fulfilment
 * (e.g. scheme closed) — releases reservation hold and runs normal admin cancellation + refund.
 */
export async function adminReleaseInvalidSchemeBacking(req) {
  const orderId = req.params.orderId;
  const tenantId = req.auth.tenantId;

  const probe = await withTransaction(async (session) => {
    const order = await EcommerceOrder.findOne({ _id: orderId, tenantId }).session(session);
    if (!order) throw errors.notFound("Order");
    const purchase = order.financialSnapshot?.schemePurchase;
    if (!purchase?.schemeId) {
      throw errors.business("NOT_SCHEME_ORDER", "This order is not a scheme-backed checkout.");
    }
    if (!RELEASE_ELIGIBLE_STATUSES.has(order.status)) {
      throw errors.business(
        "ORDER_NOT_RELEASABLE",
        "Only unpaid, paid, or pre-ship orders can release invalid scheme backing.",
        { status: order.status },
      );
    }
    const cap = adminCancellationEligible(order.toObject());
    if (!cap.allowed) {
      throw errors.business("ORDER_NOT_ADMIN_CANCELLABLE", "Order cannot be cancelled by staff.", cap);
    }
    const scheme = await Scheme.findOne({ _id: purchase.schemeId, tenantId }).session(session).lean();
    if (scheme?.status === SchemeStatus.MATURED) {
      const hold = await EcommerceSchemeReservation.findOne({
        tenantId,
        orderId: order._id,
        status: "HELD",
      }).session(session).lean();
      if (hold) {
        try {
          await assertLinkedSchemeBacking(order, session);
          throw errors.business(
            "SCHEME_BACKING_STILL_VALID",
            "The backing scheme is still matured and valid. Use normal cancellation if the customer asked to cancel.",
          );
        } catch (err) {
          if (err?.code !== "SCHEME_BACKING_CHANGED") throw err;
        }
      } else {
        throw errors.business(
          "SCHEME_BACKING_STILL_VALID",
          "Scheme is still matured and no blocked hold was found.",
        );
      }
    }
    return { orderVersion: order.version ?? 0 };
  });

  const reason = String(
    req.body.reason
      ?? "Scheme backing invalid — releasing scheme hold and cancelling order.",
  ).trim();
  req.body = {
    ...req.body,
    reason: reason.length >= 8 ? reason : "Scheme backing invalid — staff released hold and cancelled.",
    expectedVersion: Number(req.body.expectedVersion ?? probe.orderVersion),
    stockDisposition: req.body.stockDisposition ?? "RESTOCK_CONFIRMED",
  };
  return adminInitiateCancellation(req);
}

export async function schemeOrderBackingReleaseEligible(tenantId, order) {
  const purchase = order?.financialSnapshot?.schemePurchase;
  if (!purchase?.schemeId) return { eligible: false };
  if (!RELEASE_ELIGIBLE_STATUSES.has(order.status)) return { eligible: false };
  const cap = adminCancellationEligible(order);
  if (!cap.allowed) return { eligible: false, code: cap.code };
  const scheme = await Scheme.findOne({ _id: purchase.schemeId, tenantId })
    .select("status enrollmentNumber")
    .lean();
  if (scheme?.status === SchemeStatus.MATURED) {
    const hold = await EcommerceSchemeReservation.exists({
      tenantId,
      orderId: order._id,
      status: "HELD",
    });
    if (!hold) return { eligible: false, code: "NO_HELD_SCHEME" };
    return {
      eligible: true,
      reason: "Fulfilment may fail with scheme backing changed. Release hold and cancel if the enrolment is no longer valid.",
      schemeStatus: scheme.status,
      schemeNumber: scheme.enrollmentNumber,
    };
  }
  return {
    eligible: true,
    reason: "Backing enrolment is not matured. Cancel to release scheme hold and refund any top-up.",
    schemeStatus: scheme?.status,
    schemeNumber: scheme?.enrollmentNumber,
  };
}