import { sendList, sendSuccess } from "../lib/response.js";
import { assertBookingPaymentsEnabled } from "../lib/ecommerce-booking-flags.js";
import * as booking from "../services/ecommerce-booking.service.js";
import * as bookingAvailability from "../services/ecommerce-booking-availability.service.js";
import * as bookingAdmin from "../services/ecommerce-booking-admin.service.js";
import * as bookingPolicy from "../services/ecommerce-booking-policy.service.js";
import * as bookingPayment from "../services/ecommerce-booking-payment-initiation.service.js";
import { Permission } from "../constants/permissions.js";
import { writeAudit } from "../services/audit.service.js";
import { AuditEntityType } from "../constants/enums.js";
import { AppError, errors } from "../lib/app-error.js";
import { bookingStaffScope } from "../lib/ecommerce-booking-scope.js";
import { assertEcommerceOperational } from "../lib/ecommerce-access.js";
import { assertCustomerPaymentAllowed } from "../lib/ecommerce-checkout-capability.js";
import { loadPaymentCapability } from "../services/ecommerce-payment-intent.service.js";

/** Customer and staff HTTP handlers for advance ornament booking. Business rules live in the services. */

const tenantIdOf = (req) => req.auth.tenantId;
const idempotencyKeyOf = (req) => {
  const key = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!key) throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
  return key;
};

// ---- Customer ----
/**
 * Everything that must be true before a customer may be offered a booking or hold stock for one:
 * the feature is on, the store is operating, and the customer can actually pay (tax readiness,
 * gateway and rollout). The same payment check runs when the payment is started, so a piece is
 * never held for a booking that could not be paid for.
 */
async function assertBookingCheckoutAvailable(req) {
  assertBookingPaymentsEnabled();
  assertEcommerceOperational(req.tenant);
  assertCustomerPaymentAllowed(await loadPaymentCapability(tenantIdOf(req), req.tenant));
}

/** The storefront shows "Book" only when this answers 200, so it refuses exactly when creating would. */
export const shopPreviewBooking = async (req, res) => {
  await assertBookingCheckoutAvailable(req);
  sendSuccess(res, await booking.previewBooking({
    tenantId: tenantIdOf(req), productId: req.query.productId, pickupBranchId: req.query.pickupBranchId,
  }));
};

/** The pickup branches where this piece can be booked, each with its preview. */
export const shopBookingAvailability = async (req, res) => {
  await assertBookingCheckoutAvailable(req);
  sendSuccess(res, await bookingAvailability.listBookableBranches({
    tenantId: tenantIdOf(req), productId: req.query.productId,
  }));
};

export const shopCreateBooking = async (req, res) => {
  await assertBookingCheckoutAvailable(req);
  const result = await booking.createBooking({
    tenantId: tenantIdOf(req),
    customerId: req.auth.id,
    productId: req.body.productId,
    pickupBranchId: req.body.pickupBranchId,
    acceptedPolicyVersionId: req.body.acceptedPolicyVersionId,
    acceptedAdvancePaise: req.body.acceptedAdvancePaise,
    acceptedEstimateTotalPaise: req.body.acceptedEstimateTotalPaise,
    acceptedRatePerGramPaise: req.body.acceptedRatePerGramPaise,
    idempotencyKey: idempotencyKeyOf(req),
  });
  sendSuccess(res, await bookingAdmin.getCustomerBooking({
    tenantId: tenantIdOf(req), customerId: req.auth.id, bookingId: result.booking._id,
  }), {}, result.created ? 201 : 200);
};

export const shopListBookings = async (req, res) => {
  const result = await bookingAdmin.listCustomerBookings({
    tenantId: tenantIdOf(req), customerId: req.auth.id, cursor: req.query.cursor, limit: req.query.limit,
  });
  return sendList(res, { data: result.items, meta: result.meta });
};

export const shopGetBooking = async (req, res) =>
  sendSuccess(res, await bookingAdmin.getCustomerBooking({
    tenantId: tenantIdOf(req), customerId: req.auth.id, bookingId: req.params.bookingId,
  }));

export const shopCancelBooking = async (req, res) => {
  await booking.cancelBooking({
    tenantId: tenantIdOf(req), bookingId: req.params.bookingId, customerId: req.auth.id,
    actorId: req.auth.id, staff: false, reason: req.body.reason ?? "Cancelled by customer",
  });
  sendSuccess(res, await bookingAdmin.getCustomerBooking({
    tenantId: tenantIdOf(req), customerId: req.auth.id, bookingId: req.params.bookingId,
  }));
};

export const shopCreateBookingPaymentIntent = async (req, res) => {
  const result = await bookingPayment.initiateBookingPayment({
    tenant: req.tenant,
    tenantId: tenantIdOf(req),
    customerId: req.auth.id,
    bookingId: req.params.bookingId,
    redirectUrl: req.body.redirectUrl,
    clientPlatform: req.body.clientPlatform,
    checkoutChannel: req.body.checkoutChannel,
  });
  sendSuccess(res, { paymentIntent: result.paymentIntent }, {}, result.created ? 201 : 200);
};

export const shopGetBookingPaymentIntent = async (req, res) =>
  sendSuccess(res, await bookingPayment.getBookingPaymentIntent({
    tenantId: tenantIdOf(req), customerId: req.auth.id,
    bookingId: req.params.bookingId, paymentAttemptId: req.params.paymentAttemptId,
  }));

/** Customer-facing refund progress for one booking: the refund rows and the roll-up status. */
export const shopGetBookingRefunds = async (req, res) => {
  const view = await bookingAdmin.getCustomerBooking({
    tenantId: tenantIdOf(req), customerId: req.auth.id, bookingId: req.params.bookingId,
  });
  sendSuccess(res, { bookingId: view.id, refundStatus: view.refundStatus, refunds: view.refunds });
};

// ---- Staff ----
// Every handler resolves the caller's branch scope from the verified token and passes it down, so a
// branch user can only list, read or act on bookings picked up at their own branch.
const staffScope = (req) => ({ tenantId: tenantIdOf(req), ...bookingStaffScope(req) });

export const listBookings = async (req, res) => {
  const result = await bookingAdmin.listAdminBookings({ ...req.query, ...staffScope(req) });
  return sendList(res, { data: result.items, meta: result.meta });
};

export const getBooking = async (req, res) =>
  sendSuccess(res, await bookingAdmin.getAdminBooking({ ...staffScope(req), bookingId: req.params.bookingId }));

export const billBooking = async (req, res) => {
  const scope = staffScope(req);
  await booking.createBalanceQuote({ ...scope, bookingId: req.params.bookingId, actorId: req.auth.id });
  sendSuccess(res, await bookingAdmin.getAdminBooking({ ...scope, bookingId: req.params.bookingId }));
};

export const requoteBooking = async (req, res) => {
  const scope = staffScope(req);
  await booking.requoteBalance({ ...scope, bookingId: req.params.bookingId, actorId: req.auth.id, reason: req.body.reason });
  sendSuccess(res, await bookingAdmin.getAdminBooking({ ...scope, bookingId: req.params.bookingId }));
};

const canWaiveFee = (req) => {
  const granted = req.auth?.permissions ?? [];
  return granted.includes("*") || granted.includes(Permission.ECOMMERCE_BOOKING_FEE_WAIVE);
};

export const staffCancelBooking = async (req, res) => {
  const scope = staffScope(req);
  const waiveFee = req.body.waiveFee === true;
  // Cancelling under the policy needs only the booking permission. Giving up the fee is a separate
  // authority, so a branch manager asking for a waiver is refused rather than quietly charged.
  if (waiveFee && !canWaiveFee(req)) {
    throw new AppError("FEE_WAIVER_NOT_PERMITTED", "You are not authorised to waive the cancellation fee.", 403);
  }
  await booking.cancelBooking({
    ...scope, bookingId: req.params.bookingId, actorId: req.auth.id,
    staff: true, waiveFee, reason: req.body.reason,
    onCancelled: ({ before, after, refundPaise, feePaise, feeWaivedPaise, session }) => writeAudit({
      req,
      action: waiveFee ? "BOOKING_CANCELLED_FEE_WAIVED" : "BOOKING_CANCELLED_BY_STAFF",
      entityType: AuditEntityType.ECOMMERCE_BOOKING,
      entityId: String(before._id),
      before: { status: before.status, branchId: before.pickupBranchId },
      after: { status: after.status, branchId: after.pickupBranchId },
      metadata: {
        reason: req.body.reason,
        staffId: req.auth.id,
        staffRole: req.auth.role,
        feeWaived: waiveFee && feeWaivedPaise > 0,
        feeWaivedPaise,
        feeChargedPaise: feePaise,
        refundPaise,
      },
      session,
    }),
  });
  sendSuccess(res, await bookingAdmin.getAdminBooking({ ...scope, bookingId: req.params.bookingId }));
};

export const recordBookingManualRefund = async (req, res) =>
  sendSuccess(res, await bookingAdmin.recordBookingRefundManual({
    ...staffScope(req),
    bookingId: req.params.bookingId,
    refundId: req.params.refundId,
    reference: req.body.providerRefundReference,
    reason: req.body.reason,
    evidenceNote: req.body.evidenceNote,
    userId: req.auth.id,
  }));

export const retryBookingRefund = async (req, res) =>
  sendSuccess(res, await bookingAdmin.retryBookingRefund({
    ...staffScope(req), bookingId: req.params.bookingId, refundId: req.params.refundId,
  }));

// ---- Policy admin ----
export const listBookingPolicies = async (req, res) =>
  sendSuccess(res, { versions: await bookingAdmin.listPolicyVersions({ tenantId: tenantIdOf(req) }) });

export const listBookingPolicyAssignments = async (req, res) =>
  sendSuccess(res, { assignments: await bookingAdmin.listPolicyAssignments({ tenantId: tenantIdOf(req) }) });

export const createBookingPolicyDraft = async (req, res) => {
  const { policyKey, name, ...fields } = req.body;
  const draft = await bookingPolicy.createPolicyDraft({ tenantId: tenantIdOf(req), policyKey, name, fields });
  sendSuccess(res, bookingAdmin.policyVersionView(draft), {}, 201);
};

export const publishBookingPolicy = async (req, res) =>
  sendSuccess(res, bookingAdmin.policyVersionView(await bookingPolicy.publishPolicyVersion({
    tenantId: tenantIdOf(req), policyVersionId: req.params.policyVersionId, publishedBy: req.auth.id,
  })));

export const setBookingPolicyAssignment = async (req, res) =>
  sendSuccess(res, bookingAdmin.policyAssignmentView(await bookingPolicy.setPolicyAssignment({
    tenantId: tenantIdOf(req), ...req.body, updatedBy: req.auth.id,
  })));
