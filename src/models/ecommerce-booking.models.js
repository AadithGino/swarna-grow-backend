import mongoose from "mongoose";
import {
  EcommerceBookingAdvanceMode,
  EcommerceBookingPaymentStatus,
  EcommerceBookingPolicyScope,
  EcommerceBookingPolicyStatus,
  EcommerceBookingRateRule,
  EcommerceBookingRefundStatus,
  EcommerceBookingStatus,
  EcommerceFulfilmentMode,
} from "../constants/enums.js";
import {
  baseOptions,
  enumField,
  integerField,
  optionalIntegerField,
  stringId,
  tenantField,
  versionField,
} from "./schema-helpers.js";

/**
 * A booking policy version is immutable once PUBLISHED: bookings snapshot the effective policy, so
 * editing a published version would silently change nothing for existing bookings and everything
 * for new ones. Changing a policy means publishing a new version and re-pointing assignments.
 */
const policyVersionSchema = new mongoose.Schema(
  {
    _id: stringId("epolv"),
    tenantId: tenantField,
    /** Groups the versions of one named policy. */
    policyKey: { type: String, required: true, trim: true, maxlength: 80 },
    version: integerField({ min: 1 }),
    name: { type: String, required: true, trim: true, maxlength: 120 },
    status: enumField(EcommerceBookingPolicyStatus, { default: EcommerceBookingPolicyStatus.DRAFT }),
    advance: {
      mode: enumField(EcommerceBookingAdvanceMode, { required: true }),
      /** PERCENT: share of the estimated total, in basis points. */
      percentBps: optionalIntegerField({ min: 1, max: 10_000 }),
      /** FIXED: whole paise. */
      fixedPaise: optionalIntegerField({ min: 1 }),
      /** Floor applied to a percentage advance. */
      minPaise: optionalIntegerField({ min: 0, default: 0 }),
    },
    rateRule: enumField(EcommerceBookingRateRule, { required: true }),
    /** How long after the advance the booked rate can be used (BOOKED_RATE, LOWER_OF_...). */
    rateProtectionHours: integerField({ min: 0, default: 0 }),
    /** How long the customer has to pay the advance once the stock is held. */
    advanceWindowMinutes: integerField({ min: 1, default: 30 }),
    /** How long after the advance the booking stays open for the balance. */
    balanceWindowHours: integerField({ min: 1, default: 72 }),
    eligiblePickupBranchIds: { type: [String], default: [] },
    /** Stored for the policy; release 1 only books branch pickup. */
    shippingAllowed: { type: Boolean, default: false },
    reminderHoursBeforeDue: { type: [Number], default: [] },
    /** Share of a captured advance kept when the customer cancels, in basis points. */
    cancellationFeeBps: integerField({ min: 0, max: 10_000, default: 0 }),
    terms: {
      text: { type: String, trim: true, maxlength: 20_000, default: "" },
      hash: { type: String, trim: true, maxlength: 64, default: "" },
    },
    publishedAt: Date,
    publishedBy: String,
  },
  baseOptions,
);
policyVersionSchema.index({ tenantId: 1, policyKey: 1, version: 1 }, { unique: true });
policyVersionSchema.index({ tenantId: 1, status: 1 });

/**
 * Which policy applies where. Resolution order is product, then category, then the pickup branch's
 * default. An assignment with bookingEnabled=false switches booking off for its scope, and a
 * product-level "off" wins over everything else.
 */
const policyAssignmentSchema = new mongoose.Schema(
  {
    _id: stringId("epola"),
    tenantId: tenantField,
    scopeType: enumField(EcommerceBookingPolicyScope, { required: true }),
    scopeId: { type: String, required: true, trim: true, maxlength: 80 },
    bookingEnabled: { type: Boolean, default: true },
    policyVersionId: { type: String, trim: true, maxlength: 80 },
    active: { type: Boolean, default: true },
    updatedBy: String,
  },
  baseOptions,
);
policyAssignmentSchema.index(
  { tenantId: 1, scopeType: 1, scopeId: 1 },
  { unique: true, partialFilterExpression: { active: true }, name: "ecommerce_booking_assignment_active_unique" },
);
policyAssignmentSchema.pre("validate", function requirePolicyWhenEnabled(next) {
  if (this.bookingEnabled && !this.policyVersionId) {
    return next(new Error("An enabled booking assignment needs a policyVersionId."));
  }
  return next();
});

const bookingSchema = new mongoose.Schema(
  {
    _id: stringId("ebook"),
    tenantId: tenantField,
    customerId: { type: String, required: true, index: true },
    bookingNumber: { type: String, required: true, trim: true },
    /** Lifecycle, payment and refund are tracked separately. */
    status: enumField(EcommerceBookingStatus, { default: EcommerceBookingStatus.PENDING_ADVANCE }),
    paymentStatus: enumField(EcommerceBookingPaymentStatus, { default: EcommerceBookingPaymentStatus.UNPAID }),
    refundStatus: enumField(EcommerceBookingRefundStatus, { default: EcommerceBookingRefundStatus.NONE }),

    productId: { type: String, required: true },
    productVersion: Number,
    productName: String,
    sku: String,
    quantity: integerField({ min: 1, max: 1, default: 1 }),
    fulfilmentMode: enumField(EcommerceFulfilmentMode, { default: EcommerceFulfilmentMode.BRANCH_PICKUP }),
    pickupBranchId: { type: String, required: true },

    /** The policy as it applied when the customer accepted it. */
    policy: {
      policyVersionId: { type: String, required: true },
      scopeType: String,
      scopeId: String,
      snapshot: mongoose.Schema.Types.Mixed,
      termsAcceptedAt: Date,
    },

    /** Price shown when the advance was quoted. Not an invoice. */
    estimate: {
      totalPaise: integerField({ min: 1 }),
      quotedAt: Date,
      lines: mongoose.Schema.Types.Mixed,
    },
    /** Gold rate booked with the advance; only meaningful for gold-rate products. */
    bookedRate: {
      ratePerGramPaise: optionalIntegerField({ min: 1 }),
      purity: String,
      rateId: String,
      rateVersion: Number,
      savedAt: Date,
      protectedUntil: Date,
    },

    advance: {
      requiredPaise: integerField({ min: 1 }),
      capturedPaise: integerField({ min: 0, default: 0 }),
      attemptId: String,
      capturedAt: Date,
    },
    balance: {
      capturedPaise: integerField({ min: 0, default: 0 }),
      attemptId: String,
      capturedAt: Date,
    },
    /** Invoice frozen at balance quote creation. The order is built from this, never recomputed. */
    finalBilling: {
      frozenAt: Date,
      rateSource: String,
      subtotalPaise: optionalIntegerField({ min: 0 }),
      taxPaise: optionalIntegerField({ min: 0 }),
      fulfilmentChargePaise: optionalIntegerField({ min: 0 }),
      totalPaise: optionalIntegerField({ min: 0 }),
      balancePaise: optionalIntegerField({ min: 0 }),
      excessAdvancePaise: optionalIntegerField({ min: 0 }),
      lines: mongoose.Schema.Types.Mixed,
      financialSnapshot: mongoose.Schema.Types.Mixed,
    },

    /** The advance payment session, then (after capture) the balance deadline. */
    advanceDueAt: Date,
    balanceDueAt: Date,
    /** The deadline the expiry job scans on for the current status; null once terminal. */
    expiryAt: Date,

    convertedOrderId: String,
    convertedAt: Date,
    confirmedAt: Date,
    cancelledAt: Date,
    cancelledBy: String,
    cancelReason: { type: String, trim: true, maxlength: 240 },
    /** Earlier invoices replaced by a staff re-quote: { at, by, reason, previous }. */
    billingRevisions: { type: [mongoose.Schema.Types.Mixed], default: [] },
    /** Share of the advance kept on a customer cancellation (policy snapshot at the time). */
    cancellationFeePaise: optionalIntegerField({ min: 0 }),
    /** Set when staff with the waiver permission cancelled without the policy fee. */
    cancellationFeeWaiver: new mongoose.Schema({
      waivedPaise: optionalIntegerField({ min: 0 }),
      by: String,
      at: Date,
    }, { _id: false }),
    expiredAt: Date,
    lastPaymentFailure: mongoose.Schema.Types.Mixed,
    /** Expiry could not settle this booking yet (provider unresolved, error); skipped by the scan until then. */
    expiryRetryAt: Date,
    /** Bumped by every refund settlement so concurrent settlements of one booking serialize on this row. */
    refundSettlementSeq: integerField({ min: 0, default: 0 }),
    expiryDeferrals: integerField({ min: 0, default: 0 }),

    idempotencyKey: { type: String, trim: true, maxlength: 80 },
    version: versionField,
  },
  baseOptions,
);
bookingSchema.index({ tenantId: 1, bookingNumber: 1 }, { unique: true });
bookingSchema.index(
  { tenantId: 1, customerId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } } },
);
bookingSchema.index(
  { tenantId: 1, convertedOrderId: 1 },
  { unique: true, partialFilterExpression: { convertedOrderId: { $type: "string" } }, name: "ecommerce_booking_converted_order_unique" },
);
// The expiry job: open bookings whose current deadline has passed.
bookingSchema.index(
  { status: 1, expiryAt: 1 },
  { partialFilterExpression: { status: { $in: ["PENDING_ADVANCE", "CONFIRMED", "BALANCE_PENDING"] } }, name: "ecommerce_booking_expiry_scan" },
);
bookingSchema.index({ tenantId: 1, pickupBranchId: 1, status: 1, createdAt: -1 });
// Reminder job scans and the customer and staff lists.
bookingSchema.index(
  { status: 1, advanceDueAt: 1 },
  { partialFilterExpression: { status: "PENDING_ADVANCE" }, name: "ecommerce_booking_reminder_advance" },
);
bookingSchema.index(
  { status: 1, balanceDueAt: 1 },
  { partialFilterExpression: { status: { $in: ["CONFIRMED", "BALANCE_PENDING"] } }, name: "ecommerce_booking_reminder_balance" },
);
bookingSchema.index(
  { status: 1, "bookedRate.protectedUntil": 1 },
  { partialFilterExpression: { status: { $in: ["CONFIRMED", "BALANCE_PENDING"] } }, name: "ecommerce_booking_reminder_rate" },
);
bookingSchema.index(
  { status: 1, updatedAt: -1 },
  { partialFilterExpression: { status: "EXPIRED" }, name: "ecommerce_booking_reminder_expired" },
);
bookingSchema.index(
  { refundStatus: 1, updatedAt: -1 },
  { partialFilterExpression: { refundStatus: "SETTLED" }, name: "ecommerce_booking_reminder_refund" },
);
bookingSchema.index({ tenantId: 1, customerId: 1, createdAt: -1 });
bookingSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

export const EcommerceBookingPolicyVersion = mongoose.model("EcommerceBookingPolicyVersion", policyVersionSchema);
export const EcommerceBookingPolicyAssignment = mongoose.model("EcommerceBookingPolicyAssignment", policyAssignmentSchema);
export const EcommerceBooking = mongoose.model("EcommerceBooking", bookingSchema);
