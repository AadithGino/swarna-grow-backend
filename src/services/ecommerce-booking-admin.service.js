import { bookingRateProtectionEndsEarly } from "../lib/ecommerce-booking-policy.js";
import { recomputeBookingRefundStatusFor } from "../lib/ecommerce-booking-refund-status.js";
import { errors } from "../lib/app-error.js";
import { createId } from "../lib/ids.js";
import { paginate } from "../lib/pagination.js";
import { withTransaction } from "../lib/transaction.js";
import { bookingBranchCondition, loadBookingInScope } from "../lib/ecommerce-booking-scope.js";
import { claimManualRefund } from "../lib/ecommerce-manual-refund.js";
import { initiateBookingCaptureRefund } from "./ecommerce-payment-exception-refund.service.js";
import {
  Branch,
  Customer,
  EcommerceBooking,
  EcommerceBookingPolicyAssignment,
  EcommerceBookingPolicyVersion,
  EcommerceCategory,
  EcommerceProduct,
  EcommerceOrder,
  EcommercePaymentAttempt,
  EcommercePaymentAttemptEvent,
  EcommercePaymentExceptionRefund,
} from "../models/index.js";

/** Read models and staff-only refund recording for bookings. */

const refundView = (r, { staff = true } = {}) => ({
  id: r._id,
  amountPaise: r.amountPaise,
  status: r.status,
  source: r.refundSource,
  orderId: r.orderId ?? null,
  paymentAttemptId: r.paymentAttemptId,
  // Provider failure detail is for staff; a customer only needs the status.
  ...(staff ? { failureReason: r.failureReason ?? null } : {}),
  createdAt: r.createdAt ?? null,
});

function bookingView(b, { refunds = [], order = null, staff = false, customer = null, branch = null } = {}) {
  return {
    id: b._id,
    bookingNumber: b.bookingNumber,
    status: b.status,
    paymentStatus: b.paymentStatus,
    refundStatus: b.refundStatus,
    product: { id: b.productId, name: b.productName, sku: b.sku },
    pickupBranchId: b.pickupBranchId,
    pickupBranch: branch ? { id: branch._id, name: branch.name, code: branch.code ?? null } : null,
    estimateTotalPaise: b.estimate?.totalPaise ?? null,
    advance: {
      requiredPaise: b.advance?.requiredPaise ?? null,
      capturedPaise: b.advance?.capturedPaise ?? 0,
      capturedAt: b.advance?.capturedAt ?? null,
    },
    balance: {
      requiredPaise: b.finalBilling?.balancePaise ?? null,
      capturedPaise: b.balance?.capturedPaise ?? 0,
    },
    finalBilling: b.finalBilling?.totalPaise == null ? null : {
      totalPaise: b.finalBilling.totalPaise,
      subtotalPaise: b.finalBilling.subtotalPaise,
      taxPaise: b.finalBilling.taxPaise,
      balancePaise: b.finalBilling.balancePaise,
      excessAdvancePaise: b.finalBilling.excessAdvancePaise,
      rateSource: b.finalBilling.rateSource,
    },
    rateProtectedUntil: b.bookedRate?.protectedUntil ?? null,
    advanceDueAt: b.advanceDueAt ?? null,
    balanceDueAt: b.balanceDueAt ?? null,
    expiryAt: b.expiryAt ?? null,
    policy: {
      policyVersionId: b.policy?.policyVersionId,
      termsText: b.policy?.snapshot?.terms?.text ?? "",
      termsAcceptedAt: b.policy?.termsAcceptedAt ?? null,
      cancellationFeeBps: b.policy?.snapshot?.cancellationFeeBps ?? 0,
      rateRule: b.policy?.snapshot?.rateRule,
    },
    convertedOrderId: b.convertedOrderId ?? null,
    order: order ? { id: order._id, orderNumber: order.orderNumber, status: order.status, totalPaise: order.totalPaise } : null,
    cancelledAt: b.cancelledAt ?? null,
    cancellationFeePaise: b.cancellationFeePaise ?? null,
    refunds: refunds.map((r) => refundView(r, { staff })),
    createdAt: b.createdAt ?? null,
    ...(staff ? {
      customerId: b.customerId,
      // Staff at the counter need to know who booked; a customer view never carries this.
      customer: customer ? { id: customer._id, name: customer.name, mobile: customer.mobile, customerNumber: customer.customerNumber } : null,
      cancelReason: b.cancelReason ?? null,
      cancelledBy: b.cancelledBy ?? null,
      feeWaiver: b.cancellationFeeWaiver?.by ? { waivedPaise: b.cancellationFeeWaiver.waivedPaise ?? 0, by: b.cancellationFeeWaiver.by, at: b.cancellationFeeWaiver.at ?? null } : null,
      lastPaymentFailure: b.lastPaymentFailure ?? null,
      expiryDeferrals: b.expiryDeferrals ?? 0,
      billingRevisions: (b.billingRevisions ?? []).map((r) => ({ at: r.at, by: r.by, reason: r.reason, previousTotalPaise: r.previous?.totalPaise ?? null })),
      version: b.version,
    } : {}),
  };
}

async function withRefundsAndOrder(rows, tenantId, staff) {
  const ids = rows.map((r) => r._id);
  const refunds = await EcommercePaymentExceptionRefund.find({ tenantId, bookingId: { $in: ids } }).sort({ createdAt: 1 }).lean();
  const orderIds = rows.map((r) => r.convertedOrderId).filter(Boolean);
  const orders = orderIds.length ? await EcommerceOrder.find({ tenantId, _id: { $in: orderIds } }).lean() : [];
  const orderById = new Map(orders.map((o) => [o._id, o]));
  const branchIds = [...new Set(rows.map((r) => r.pickupBranchId).filter(Boolean))];
  const customerIds = staff ? [...new Set(rows.map((r) => r.customerId).filter(Boolean))] : [];
  const [branches, customers] = await Promise.all([
    branchIds.length ? Branch.find({ tenantId, _id: { $in: branchIds } }).select("name code").lean() : [],
    customerIds.length ? Customer.find({ tenantId, _id: { $in: customerIds } }).select("name mobile customerNumber").lean() : [],
  ]);
  const branchById = new Map(branches.map((x) => [x._id, x]));
  const customerById = new Map(customers.map((x) => [x._id, x]));
  return rows.map((b) => bookingView(b, {
    refunds: refunds.filter((r) => r.bookingId === b._id),
    order: orderById.get(b.convertedOrderId) ?? null,
    staff,
    branch: branchById.get(b.pickupBranchId) ?? null,
    customer: staff ? customerById.get(b.customerId) ?? null : null,
  }));
}

export async function listCustomerBookings({ tenantId, customerId, cursor, limit }) {
  const page = await paginate(EcommerceBooking, { scope: { tenantId, customerId }, cursor, limit, sort: "createdAt:desc" });
  return { items: await withRefundsAndOrder(page.data, tenantId, false), meta: page.meta };
}

export async function getCustomerBooking({ tenantId, customerId, bookingId }) {
  const row = await EcommerceBooking.findOne({ _id: bookingId, tenantId, customerId }).lean();
  if (!row) throw errors.notFound("Booking");
  return (await withRefundsAndOrder([row], tenantId, false))[0];
}

export async function listAdminBookings({ tenantId, branchId = null, status, refundStatus, pickupBranchId, q, cursor, limit }) {
  // A branch user is pinned to their own branch. The scope is applied last and the caller's branch
  // filter may only narrow to that same branch; a different one is refused, not silently ignored.
  if (branchId && pickupBranchId && String(pickupBranchId) !== String(branchId)) {
    throw errors.forbidden("Bookings of another branch are outside your branch scope.");
  }
  const escaped = q ? q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : null;
  const filters = {
    ...(status ? { status } : {}),
    ...(refundStatus ? { refundStatus } : {}),
    ...(!branchId && pickupBranchId ? { pickupBranchId } : {}),
    ...(escaped ? { $or: [{ bookingNumber: new RegExp(`^${escaped}`, "i") }, { productName: new RegExp(escaped, "i") }] } : {}),
  };
  const scope = { tenantId, ...bookingBranchCondition(branchId) };
  const page = await paginate(EcommerceBooking, { scope, filters, cursor, limit, sort: "createdAt:desc" });
  return { items: await withRefundsAndOrder(page.data, tenantId, true), meta: page.meta };
}

export async function getAdminBooking({ tenantId, bookingId, branchId = null }) {
  const row = await loadBookingInScope({ tenantId, bookingId, branchId });
  const [view] = await withRefundsAndOrder([row], tenantId, true);
  const attempts = await EcommercePaymentAttempt.find({ tenantId, bookingId }).sort({ createdAt: 1 }).lean();
  const events = await EcommercePaymentAttemptEvent.find({ tenantId, bookingId }).sort({ at: 1 }).limit(200).lean();
  return {
    ...view,
    attempts: attempts.map((a) => ({
      id: a._id, purpose: a.purpose, status: a.status, amountPaise: a.amountPaise, providerOrderId: a.providerOrderId ?? null,
      operationalStatus: a.operationalStatus ?? null, failureReason: a.failureReason ?? null, expiresAt: a.expiresAt ?? null, createdAt: a.createdAt,
    })),
    events: events.map((e) => ({ at: e.at, outcome: e.outcome, reason: e.reason ?? "", paymentAttemptId: e.paymentAttemptId })),
  };
}

/** One shape for a policy version in every response, so a client can use the `id` it was given. */
export const policyVersionView = (r) => ({
  id: r._id, policyKey: r.policyKey, version: r.version, name: r.name, status: r.status, advance: r.advance, rateRule: r.rateRule,
  rateProtectionHours: r.rateProtectionHours,
  rateProtectionEndsBeforeBalanceDeadline: bookingRateProtectionEndsEarly(r),
  advanceWindowMinutes: r.advanceWindowMinutes, balanceWindowHours: r.balanceWindowHours,
  eligiblePickupBranchIds: r.eligiblePickupBranchIds ?? [], cancellationFeeBps: r.cancellationFeeBps ?? 0,
  reminderHoursBeforeDue: r.reminderHoursBeforeDue ?? [], termsText: r.terms?.text ?? "", publishedAt: r.publishedAt ?? null,
});

export const policyAssignmentView = (r) => ({
  id: r._id, scopeType: r.scopeType, scopeId: r.scopeId, bookingEnabled: r.bookingEnabled, policyVersionId: r.policyVersionId ?? null,
});

export async function listPolicyVersions({ tenantId }) {
  const rows = await EcommerceBookingPolicyVersion.find({ tenantId }).sort({ policyKey: 1, version: -1 }).limit(200).lean();
  return rows.map(policyVersionView);
}

export async function listPolicyAssignments({ tenantId }) {
  const rows = await EcommerceBookingPolicyAssignment.find({ tenantId, active: true }).sort({ scopeType: 1, scopeId: 1 }).limit(500).lean();
  const productIds = rows.filter((row) => row.scopeType === "PRODUCT").map((row) => row.scopeId);
  const categoryIds = rows.filter((row) => row.scopeType === "CATEGORY").map((row) => row.scopeId);
  const [products, categories] = await Promise.all([
    productIds.length ? EcommerceProduct.find({ tenantId, _id: { $in: productIds } }).select("name").lean() : [],
    categoryIds.length ? EcommerceCategory.find({ tenantId, _id: { $in: categoryIds } }).select("name").lean() : [],
  ]);
  const names = new Map([...products, ...categories].map((row) => [row._id, row.name]));
  return rows.map((row) => ({ ...policyAssignmentView(row), scopeName: names.get(row.scopeId) ?? null }));
}

/**
 * Staff records that a booking-owned refund (one with no order: cancellation or expiry) was paid
 * outside the gateway. Uses the same claim as the order refund routes, so it is refused while a
 * provider outcome is pending and it settles the booking's refundStatus through the same check.
 */
export async function recordBookingRefundManual({ tenantId, bookingId, branchId = null, refundId, reference, reason, evidenceNote, userId }) {
  if (String(reference ?? "").trim().length < 4) throw errors.validation([{ field: "providerRefundReference", message: "A reference of at least 4 characters is required." }]);
  if (String(reason ?? "").trim().length < 8) throw errors.validation([{ field: "reason", message: "A reason of at least 8 characters is required." }]);
  if (String(evidenceNote ?? "").trim().length < 8) throw errors.validation([{ field: "evidenceNote", message: "An evidence note of at least 8 characters is required." }]);
  return withTransaction(async (session) => {
    await loadBookingInScope({ tenantId, bookingId, branchId, session, select: "_id" });
    const row = await EcommercePaymentExceptionRefund.findOne({ _id: refundId, tenantId, bookingId }).session(session).lean();
    if (!row) throw errors.notFound("Booking refund");
    if (row.orderId) throw errors.business("REFUND_ORDER_OWNED", "This refund belongs to an order; use the order refund flow.");
    const updated = await claimManualRefund(session, { tenantId, orderId: null, refundId, reference: String(reference).trim(), userId });
    await EcommercePaymentAttemptEvent.create([{
      _id: createId("epayev"), tenantId, bookingId, purpose: row.purpose, paymentAttemptId: row.paymentAttemptId,
      direction: "INTERNAL", outcome: "REFUND_MANUALLY_RECORDED", reason: String(reason).trim(),
      payload: { refundId, reference: String(reference).trim(), evidenceNote: String(evidenceNote).trim(), recordedBy: userId },
    }], { session });
    return { refund: refundView(updated.toObject()) };
  });
}

/**
 * Staff retries a booking-owned refund that failed at the provider (or was never sent). The refund
 * must belong to this booking and have no order; the provider call and its retry rules are the same
 * ones the system uses when it first sends the refund.
 */
export async function retryBookingRefund({ tenantId, bookingId, branchId = null, refundId }) {
  await loadBookingInScope({ tenantId, bookingId, branchId, select: "_id" });
  const row = await EcommercePaymentExceptionRefund.findOne({ _id: refundId, tenantId, bookingId }).lean();
  if (!row) throw errors.notFound("Booking refund");
  const result = await initiateBookingCaptureRefund({ tenantId, refundId });
  // The row has moved (in progress, or failed again): bring the booking summary in line with it.
  await withTransaction((session) => recomputeBookingRefundStatusFor({ tenantId, bookingId, session }));
  return { refund: refundView(result.refund), initiated: result.initiated !== false, inFlight: Boolean(result.inFlight) };
}
