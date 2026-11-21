import { AppError, errors } from "../lib/app-error.js";
import { createId } from "../lib/ids.js";
import { withTransaction } from "../lib/transaction.js";
import { enqueueEcommerceOutboxEvent, ECOMMERCE_OUTBOX_TOPICS } from "../lib/ecommerce-commerce-outbox.js";
import { reserveCaptureRefund } from "../lib/ecommerce-refund-allocator.js";
import { resolveOperationalAlert, upsertOperationalAlert } from "../lib/operational-alert.js";
import { mapFulfilmentSettings } from "../lib/ecommerce-fulfilment.js";
import { loadInventoryAvailability } from "../lib/ecommerce-inventory.js";
import { bookingBranchCondition } from "../lib/ecommerce-booking-scope.js";
import { recomputeBookingRefundStatusFor } from "../lib/ecommerce-booking-refund-status.js";
import { registerBookingPaymentHandlers } from "../lib/ecommerce-booking-payment-handlers.js";
import { consumeOrderStockReservationsOnce } from "../lib/ecommerce-order-lifecycle.js";
import { snapshotStorePolicyForOrder } from "../lib/ecommerce-store-policies.js";
import {
  bookingHoldFilter,
  releaseBookingHolds,
  reserveStockForBooking,
  transferBookingHoldsToOrder,
} from "../lib/ecommerce-booking-stock.js";
import {
  advanceDueAt,
  cancellationRefundPaise,
  computeAdvancePaise,
  bookingRateProtectionEndsEarly,
  confirmedDeadlines,
} from "../lib/ecommerce-booking-policy.js";
import {
  bookedRateFromRow,
  latestRateForPurity,
  loadBookingPricingContext,
  priceBookingInvoice,
} from "../lib/ecommerce-booking-pricing.js";
import { resolveBookingPolicy } from "./ecommerce-booking-policy.service.js";
import {
  EcommerceBookingPaymentStatus,
  EcommerceBookingRefundStatus,
  AlertType,
  EcommerceBookingStatus,
  EcommerceOrderEventType,
  EcommerceOrderRefundSource,
  EcommerceOrderStatus,
  EcommercePaymentAttemptStatus,
  EcommercePaymentMethod,
  EcommercePaymentPurpose,
  EcommerceProductStatus,
  EcommerceStockPolicy,
} from "../constants/enums.js";
import {
  Branch,
  EcommerceBooking,
  EcommerceCategory,
  EcommerceOrder,
  EcommerceOrderEvent,
  EcommercePaymentAttempt,
  EcommerceProduct,
  EcommerceStockReservation,
  EcommerceFulfilmentSettings,
} from "../models/index.js";

/**
 * Advance booking lifecycle (release 1: one unit of a QUANTITY_TRACKED SKU, branch pickup).
 *
 *   PENDING_ADVANCE --advance captured--> CONFIRMED --balance quote--> BALANCE_PENDING
 *        |                                    |                              |
 *        |                                    |-- zero balance --------------+--balance captured--> CONVERTED
 *        +-- window lapses --> EXPIRED        +-- deadline / cancel --> EXPIRED / CANCELLED (advance refunded)
 *
 * Customer payment entry points stay disabled: nothing here calls the provider. Payment attempts are
 * created here and finalized by the existing payment layer, which calls the handlers installed at
 * the bottom of this file.
 */

const ATTEMPT_WINDOW_MS = 15 * 60_000;
const OPEN = [
  EcommerceBookingStatus.PENDING_ADVANCE,
  EcommerceBookingStatus.CONFIRMED,
  EcommerceBookingStatus.BALANCE_PENDING,
];
const ACTIVE_ATTEMPT = [EcommercePaymentAttemptStatus.PENDING, EcommercePaymentAttemptStatus.INITIATED];

const notFound = () => errors.notFound("Booking");
const conflict = (code, message, details) => errors.conflict(code, message, details);

function newBookingId() {
  const id = createId("ebook");
  return { id, bookingNumber: `BK-${id.slice(-10).toUpperCase()}` };
}

/** A new payment attempt for one booking purpose. Its own epay_ id doubles as the provider merchant order id. */
export async function createBookingPaymentAttempt({ booking, purpose, amountPaise, at, session }) {
  const attemptId = createId("epay");
  const deadline = new Date(booking.expiryAt);
  const expiresAt = new Date(Math.min(at.getTime() + ATTEMPT_WINDOW_MS, deadline.getTime()));
  const [row] = await EcommercePaymentAttempt.create([{
    _id: attemptId,
    tenantId: booking.tenantId,
    bookingId: booking._id,
    purpose,
    customerId: booking.customerId,
    status: EcommercePaymentAttemptStatus.PENDING,
    amountPaise,
    currency: "INR",
    provider: "PHONEPE",
    merchantOrderId: attemptId,
    expiresAt,
  }], { session });
  return row.toObject();
}

/**
 * The one gate every booking path goes through (availability, preview and creation): the product is
 * published, and the pickup branch belongs to this tenant, is active, and is offered for pickup.
 */
async function assertBookable({ tenantId, productId, pickupBranchId, session }) {
  const product = await EcommerceProduct.findOne({ _id: productId, tenantId }).session(session).lean();
  if (!product || product.status !== EcommerceProductStatus.PUBLISHED) {
    throw errors.business("PRODUCT_NOT_AVAILABLE", "Product is not published.", { productId });
  }
  if (product.categoryId) {
    const cat = await EcommerceCategory.findOne({ _id: product.categoryId, tenantId, active: true }).session(session);
    if (!cat) throw errors.business("PRODUCT_NOT_AVAILABLE", "Product category is not active.", { productId });
  }
  await assertPickupBranchBookable({ tenantId, pickupBranchId, session });
  return product;
}

async function assertPickupBranchBookable({ tenantId, pickupBranchId, session }) {
  const branchQuery = Branch.findOne({ _id: pickupBranchId, tenantId, active: { $ne: false } }).select("_id").lean();
  const branch = await (session ? branchQuery.session(session) : branchQuery);
  const fulfilmentQuery = EcommerceFulfilmentSettings.findOne({ tenantId }).lean();
  const settings = mapFulfilmentSettings((await (session ? fulfilmentQuery.session(session) : fulfilmentQuery)) ?? {});
  if (!branch || !settings.pickupEnabled || !settings.pickupBranchIds.includes(String(pickupBranchId))) {
    throw errors.business("PICKUP_BRANCH_NOT_AVAILABLE", "This pickup branch is not available for booking.", { pickupBranchId });
  }
}

/**
 * Create a booking, take its stock hold and open its advance attempt, atomically. Replaying the same
 * idempotency key returns the same booking. The customer must accept the policy version that is
 * currently effective; if it changed since they saw it, they are asked to look again.
 */
export async function createBooking({
  tenantId,
  customerId,
  productId,
  pickupBranchId,
  acceptedPolicyVersionId,
  acceptedAdvancePaise,
  acceptedEstimateTotalPaise,
  acceptedRatePerGramPaise = null,
  idempotencyKey,
  at = new Date(),
}) {
  if (!Number.isInteger(acceptedAdvancePaise) || acceptedAdvancePaise < 0
    || !Number.isInteger(acceptedEstimateTotalPaise) || acceptedEstimateTotalPaise < 0
    || (acceptedRatePerGramPaise !== null && (!Number.isInteger(acceptedRatePerGramPaise) || acceptedRatePerGramPaise < 0))) {
    throw errors.validation([{ field: "acceptedAdvancePaise", message: "The advance, estimate and rate the customer accepted are required." }]);
  }
  if (!idempotencyKey) throw errors.validation([{ field: "idempotencyKey", message: "An idempotency key is required." }]);
  const find = () => EcommerceBooking.findOne({ tenantId, customerId, idempotencyKey }).lean();
  // A key is bound to the request that first used it. Replaying the same request returns the same
  // booking; reusing the key for different input is an error, never a silent replay.
  const replayOf = (row) => {
    if (row.productId !== productId || row.pickupBranchId !== pickupBranchId
      || row.policy?.policyVersionId !== acceptedPolicyVersionId
      || row.advance?.requiredPaise !== acceptedAdvancePaise
      || row.estimate?.totalPaise !== acceptedEstimateTotalPaise
      || (row.bookedRate?.ratePerGramPaise ?? null) !== acceptedRatePerGramPaise) {
      throw new AppError("IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for a different booking request.", 422);
    }
    return { booking: row, created: false };
  };
  const prior = await find();
  if (prior) return replayOf(prior);

  try {
    return await withTransaction(async (session) => {
      const product = await assertBookable({ tenantId, productId, pickupBranchId, session });
      const { policy, scopeType, scopeId } = await resolveBookingPolicy({ tenantId, product, pickupBranchId, session });
      if (acceptedPolicyVersionId !== policy._id) {
        throw new AppError("BOOKING_POLICY_CHANGED", "The booking terms changed. Review and accept them again.", 409, {
          effectivePolicyVersionId: policy._id,
        });
      }
      const inventoryPolicy = EcommerceStockPolicy.QUANTITY_TRACKED;
      const context = await loadBookingPricingContext({ tenantId, pickupBranchId, session });
      const liveRateRow = product.priceMode === "FIXED" ? null : await latestRateForPurity(tenantId, product.purity, session);
      const quoted = priceBookingInvoice({ product, context, stage: "ADVANCE_QUOTE", liveRateRow, stockPolicy: inventoryPolicy, at });
      const advanceRequiredPaise = computeAdvancePaise(policy, quoted.totalPaise);
      // The customer agreed to specific terms: the gold rate, the estimate it gives, and the advance.
      // A fixed advance can hide a rate move (a percentage floor, a cap), so all three are checked.
      // If any moved since, nothing is held: they see the new quote and must accept it again.
      const quotedRate = liveRateRow?.ratePerGramPaise ?? null;
      if (advanceRequiredPaise !== acceptedAdvancePaise
        || quoted.totalPaise !== acceptedEstimateTotalPaise
        || quotedRate !== acceptedRatePerGramPaise) {
        throw new AppError("BOOKING_QUOTE_CHANGED", "The gold rate or price changed. Review the new quote and confirm again.", 409, {
          // `current` is the shape the error middleware passes through to the client.
          current: {
            policyVersionId: policy._id,
            estimateTotalPaise: quoted.totalPaise,
            advanceRequiredPaise,
            ratePerGramPaise: quotedRate,
          },
        });
      }
      const { id, bookingNumber } = newBookingId();
      const dueAt = advanceDueAt(policy, at);
      const bookedRate = bookedRateFromRow(liveRateRow);

      await reserveStockForBooking({ tenantId, bookingId: id, productId, quantity: 1, holdExpiresAt: dueAt, session });

      const [row] = await EcommerceBooking.create([{
        _id: id,
        tenantId,
        customerId,
        bookingNumber,
        productId,
        productVersion: product.version ?? 1,
        productName: product.name,
        sku: product.sku,
        pickupBranchId,
        policy: {
          policyVersionId: policy._id,
          scopeType,
          scopeId,
          snapshot: policy,
          termsAcceptedAt: at,
        },
        estimate: { totalPaise: quoted.totalPaise, quotedAt: at, lines: quoted.lines },
        ...(bookedRate ? { bookedRate } : {}),
        advance: { requiredPaise: advanceRequiredPaise, capturedPaise: 0 },
        advanceDueAt: dueAt,
        expiryAt: dueAt,
        idempotencyKey,
      }], { session });
      const booking = row.toObject();
      const attempt = await createBookingPaymentAttempt({
        booking, purpose: EcommercePaymentPurpose.BOOKING_ADVANCE, amountPaise: advanceRequiredPaise, at, session,
      });
      return { booking, attempt, created: true };
    });
  } catch (error) {
    if (error?.code === 11000) {
      const winner = await find();
      if (winner) return replayOf(winner);
    }
    throw error;
  }
}

/**
 * Give the customer a fresh payment attempt (and so a fresh provider order) for the current purpose.
 * The earlier attempt is never reused or rewritten: it stays on file so a capture that arrives late
 * for it can still be matched, and refunded if the booking cannot take it. While an earlier attempt
 * is still active the customer keeps it; a new one is created only after it failed or expired.
 */
export async function renewBookingPaymentAttempt({ tenantId, bookingId, customerId = null, at = new Date() }) {
  return withTransaction(async (session) => {
    const booking = await EcommerceBooking.findOne({ _id: bookingId, tenantId, ...(customerId ? { customerId } : {}) })
      .session(session).lean();
    if (!booking) throw notFound();
    let purpose;
    let amountPaise;
    if (booking.status === EcommerceBookingStatus.PENDING_ADVANCE) {
      purpose = EcommercePaymentPurpose.BOOKING_ADVANCE;
      amountPaise = booking.advance.requiredPaise;
    } else if (booking.status === EcommerceBookingStatus.BALANCE_PENDING) {
      purpose = EcommercePaymentPurpose.BOOKING_BALANCE;
      amountPaise = booking.finalBilling.balancePaise;
    } else {
      throw conflict("BOOKING_NOT_PAYABLE", "This booking is not waiting for a payment.", { status: booking.status });
    }
    if (new Date(booking.expiryAt) <= at) {
      throw conflict("BOOKING_PAYMENT_WINDOW_CLOSED", "The payment window for this booking has closed.");
    }
    const active = await EcommercePaymentAttempt.findOne({
      tenantId, bookingId, purpose, status: { $in: ACTIVE_ATTEMPT },
    }).session(session).lean();
    if (active && new Date(active.expiresAt) > at) return { attempt: active, created: false };
    if (active) {
      // Past its own deadline but not yet retired by the expiry job: it may still be paid at the
      // provider, so it is not replaced here.
      throw conflict("BOOKING_ATTEMPT_PENDING_RECONCILIATION", "The previous payment is still being checked. Try again shortly.");
    }
    const attempt = await createBookingPaymentAttempt({ booking, purpose, amountPaise, at, session });
    return { attempt, created: true };
  });
}

/**
 * Cancel an open booking. The stock hold is released and the captured advance, less any policy
 * cancellation fee, is refunded against the capture it came from. Payment attempts are left alone:
 * one that is paid after the cancel is refunded in full as a late capture.
 */
export async function cancelBooking({
  tenantId, bookingId, customerId = null, branchId = null, actorId, staff = false, waiveFee = false, reason, at = new Date(),
  onCancelled = null,
}) {
  return withTransaction(async (session) => {
    const booking = await EcommerceBooking.findOne({ _id: bookingId, tenantId, ...(customerId ? { customerId } : {}), ...bookingBranchCondition(branchId) })
      .session(session).lean();
    if (!booking) throw notFound();
    if (booking.status === EcommerceBookingStatus.CANCELLED) return { booking, replayed: true };
    if (!OPEN.includes(booking.status)) {
      throw conflict("BOOKING_NOT_CANCELLABLE", "This booking can no longer be cancelled.", { status: booking.status });
    }
    const captured = booking.advance?.capturedPaise ?? 0;
    const { refundPaise, feePaise } = cancellationRefundPaise({
      advanceCapturedPaise: captured,
      cancellationFeeBps: booking.policy?.snapshot?.cancellationFeeBps ?? 0,
      waiveFee: staff && waiveFee,
    });
    const waived = staff && waiveFee && captured > 0;
    const feeWaivedPaise = waived
      ? cancellationRefundPaise({
        advanceCapturedPaise: captured,
        cancellationFeeBps: booking.policy?.snapshot?.cancellationFeeBps ?? 0,
        waiveFee: false,
      }).feePaise
      : 0;
    const updated = await EcommerceBooking.findOneAndUpdate(
      { _id: bookingId, tenantId, status: booking.status, version: booking.version },
      {
        $set: {
          status: EcommerceBookingStatus.CANCELLED,
          cancelledAt: at,
          cancelledBy: actorId ?? null,
          cancelReason: reason ?? null,
          expiryAt: null,
          ...(captured ? { cancellationFeePaise: feePaise } : {}),
          ...(waived ? { cancellationFeeWaiver: { waivedPaise: feeWaivedPaise, by: actorId ?? null, at } } : {}),
          ...(refundPaise ? { refundStatus: EcommerceBookingRefundStatus.PENDING } : {}),
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    ).lean();
    if (!updated) throw conflict("BOOKING_CHANGED", "The booking changed. Reload and try again.");
    await releaseBookingHolds({ tenantId, bookingId, session, at });
    if (refundPaise) {
      await reserveCaptureRefund({
        tenantId,
        paymentAttemptId: booking.advance.attemptId,
        amountPaise: refundPaise,
        operationId: `booking-cancel:${bookingId}`,
        refundSource: EcommerceOrderRefundSource.BOOKING_CANCELLATION,
        session,
      });
    }
    // Runs inside the cancel transaction, so the audit entry exists if and only if the cancel does.
    if (onCancelled) await onCancelled({ before: booking, after: updated, refundPaise, feePaise, feeWaivedPaise, session });
    return { booking: updated, refundPaise, feePaise, feeWaivedPaise, replayed: false };
  });
}

function bookedRateOf(booking) {
  return booking.bookedRate?.ratePerGramPaise ? booking.bookedRate : null;
}

/** Price the final invoice under the policy's rate rule and derive balance and excess advance. */
async function priceFinalBilling({ booking, tenantId, at, session }) {
  const product = await EcommerceProduct.findOne({ _id: booking.productId, tenantId }).session(session).lean();
  if (!product) throw errors.business("PRODUCT_NOT_AVAILABLE", "Product no longer exists.", { productId: booking.productId });
  const context = await loadBookingPricingContext({ tenantId, pickupBranchId: booking.pickupBranchId, session });
  const liveRateRow = product.priceMode === "FIXED" ? null : await latestRateForPurity(tenantId, product.purity, session);
  const invoice = priceBookingInvoice({
    product,
    context,
    stage: "FINAL",
    rateRule: booking.policy.snapshot.rateRule,
    bookedRate: bookedRateOf(booking),
    liveRateRow,
    stockPolicy: EcommerceStockPolicy.QUANTITY_TRACKED,
    at,
  });
  const advancePaid = booking.advance.capturedPaise;
  const balancePaise = Math.max(0, invoice.totalPaise - advancePaid);
  return {
    frozenAt: at,
    rateSource: invoice.rateSource,
    subtotalPaise: invoice.subtotalPaise,
    taxPaise: invoice.taxPaise,
    fulfilmentChargePaise: invoice.fulfilmentChargePaise,
    totalPaise: invoice.totalPaise,
    balancePaise,
    excessAdvancePaise: Math.max(0, advancePaid - invoice.totalPaise),
    lines: invoice.lines,
    financialSnapshot: invoice.financialSnapshot,
  };
}

/**
 * Staff finalises a confirmed booking: the invoice is priced once under the policy's rate rule and
 * frozen on the booking, and the balance (invoice less advance) is asked for. A zero balance
 * converts straight away. The frozen invoice is what the customer is asked to pay and what the
 * order records; it changes only through requoteBalance, which is refused once a payment may exist.
 */
export async function createBalanceQuote({ tenantId, bookingId, branchId = null, actorId = null, at = new Date() }) {
  return withTransaction(async (session) => {
    const booking = await EcommerceBooking.findOne({ _id: bookingId, tenantId, ...bookingBranchCondition(branchId) }).session(session).lean();
    if (!booking) throw notFound();
    if (booking.status === EcommerceBookingStatus.BALANCE_PENDING || booking.status === EcommerceBookingStatus.CONVERTED) {
      return { booking, created: false };
    }
    if (booking.status !== EcommerceBookingStatus.CONFIRMED) {
      throw conflict("BOOKING_NOT_CONFIRMED", "Only a confirmed booking can be billed.", { status: booking.status });
    }
    if (new Date(booking.balanceDueAt) <= at) {
      throw conflict("BOOKING_BALANCE_WINDOW_CLOSED", "The balance window for this booking has closed.");
    }
    const finalBilling = await priceFinalBilling({ booking, tenantId, at, session });
    const { balancePaise } = finalBilling;
    const frozen = await EcommerceBooking.findOneAndUpdate(
      { _id: bookingId, tenantId, status: EcommerceBookingStatus.CONFIRMED, version: booking.version },
      {
        $set: {
          finalBilling,
          ...(balancePaise ? {
            status: EcommerceBookingStatus.BALANCE_PENDING,
            expiryAt: booking.balanceDueAt,
            expiryRetryAt: null,
            expiryDeferrals: 0,
          } : {}),
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    ).lean();
    if (!frozen) throw conflict("BOOKING_CHANGED", "The booking changed. Reload and try again.");
    if (balancePaise === 0) {
      const order = await convertBookingToOrderInTx({ booking: frozen, balanceAttempt: null, at, actorId, session });
      return { booking: order.booking, order: order.order, created: true };
    }
    const attempt = await createBookingPaymentAttempt({
      booking: frozen, purpose: EcommercePaymentPurpose.BOOKING_BALANCE, amountPaise: balancePaise, at, session,
    });
    return { booking: frozen, attempt, created: true };
  });
}

/**
 * Re-price a billed booking (for example after a wrong rate was corrected). Allowed only while no
 * balance payment can exist: every balance attempt must have ended, or never have reached the
 * provider (no provider order, no initiation claim). A never-started attempt is retired and the old
 * invoice is kept in billingRevisions. A balance attempt that may be paid blocks the re-quote; the
 * customer's payment is never made to disagree with the invoice. If the new invoice leaves nothing
 * to pay, the booking converts.
 */
export async function requoteBalance({ tenantId, bookingId, branchId = null, actorId = null, reason, at = new Date() }) {
  if (!reason || String(reason).trim().length < 8) {
    throw errors.validation([{ field: "reason", message: "A reason of at least 8 characters is required." }]);
  }
  return withTransaction(async (session) => {
    const booking = await EcommerceBooking.findOne({ _id: bookingId, tenantId, ...bookingBranchCondition(branchId) }).session(session).lean();
    if (!booking) throw notFound();
    if (booking.status !== EcommerceBookingStatus.BALANCE_PENDING) {
      throw conflict("BOOKING_NOT_AWAITING_BALANCE", "Only a booking awaiting its balance can be re-quoted.", { status: booking.status });
    }
    if (new Date(booking.balanceDueAt) <= at) {
      throw conflict("BOOKING_BALANCE_WINDOW_CLOSED", "The balance window for this booking has closed.");
    }
    const attempts = await EcommercePaymentAttempt.find({
      tenantId, bookingId, purpose: EcommercePaymentPurpose.BOOKING_BALANCE,
    }).session(session).lean();
    const mayBePaid = (a) => a.status === EcommercePaymentAttemptStatus.SUCCEEDED
      || (ACTIVE_ATTEMPT.includes(a.status)
        && (a.providerOrderId || a.initiationClaimToken || a.initiationUncertainAt));
    if (attempts.some(mayBePaid)) {
      throw conflict("BOOKING_BALANCE_IN_PROGRESS", "A balance payment is in progress or may have been paid, so the invoice cannot change.");
    }
    const finalBilling = await priceFinalBilling({ booking, tenantId, at, session });
    // Retire any never-started balance attempt so a new one for the new amount can be opened.
    await EcommercePaymentAttempt.updateMany(
      {
        tenantId, bookingId, purpose: EcommercePaymentPurpose.BOOKING_BALANCE,
        status: EcommercePaymentAttemptStatus.PENDING,
        providerOrderId: { $in: [null, ""] },
        initiationClaimToken: { $in: [null, ""] },
      },
      { $set: { status: EcommercePaymentAttemptStatus.EXPIRED, failureReason: "BOOKING_REQUOTED" }, $inc: { version: 1 } },
      { session },
    );
    const updated = await EcommerceBooking.findOneAndUpdate(
      { _id: bookingId, tenantId, status: EcommerceBookingStatus.BALANCE_PENDING, version: booking.version },
      {
        $set: { finalBilling },
        $push: { billingRevisions: { at, by: actorId, reason: String(reason).trim(), previous: booking.finalBilling } },
        $inc: { version: 1 },
      },
      { session, new: true },
    ).lean();
    if (!updated) throw conflict("BOOKING_CHANGED", "The booking changed. Reload and try again.");
    if (finalBilling.balancePaise === 0) {
      const order = await convertBookingToOrderInTx({ booking: updated, balanceAttempt: null, at, actorId, session });
      return { booking: order.booking, order: order.order };
    }
    const attempt = await createBookingPaymentAttempt({
      booking: updated, purpose: EcommercePaymentPurpose.BOOKING_BALANCE, amountPaise: finalBilling.balancePaise, at, session,
    });
    return { booking: updated, attempt };
  });
}

/**
 * Build the one paid order for a booking from its frozen invoice, inside the caller's transaction.
 * Payment allocations record the advance and balance captures (advance capped at the invoice), the
 * hold becomes the order's and is consumed (one stock deduction), and any advance above the invoice
 * opens an excess refund against the advance capture.
 */
export async function convertBookingToOrderInTx({ booking, balanceAttempt, at, actorId = null, session }) {
  const { tenantId } = booking;
  if (!booking.finalBilling?.totalPaise) throw conflict("BOOKING_NOT_BILLED", "The booking has no frozen invoice.");
  const fb = booking.finalBilling;
  const advancePaise = booking.advance.capturedPaise;
  const advanceApplied = Math.min(advancePaise, fb.totalPaise);
  const balanceApplied = fb.totalPaise - advanceApplied;
  if (balanceApplied !== (balanceAttempt?.amountPaise ?? 0)) {
    throw conflict("BOOKING_BALANCE_MISMATCH", "The balance capture does not match the frozen invoice.", {
      expectedPaise: balanceApplied, capturedPaise: balanceAttempt?.amountPaise ?? 0,
    });
  }
  const allocations = [
    { paymentAttemptId: booking.advance.attemptId, purpose: EcommercePaymentPurpose.BOOKING_ADVANCE, appliedPaise: advanceApplied },
    ...(balanceApplied ? [{ paymentAttemptId: balanceAttempt._id, purpose: EcommercePaymentPurpose.BOOKING_BALANCE, appliedPaise: balanceApplied }] : []),
  ];
  const orderId = createId("eord");
  const fulfilmentRow = await EcommerceFulfilmentSettings.findOne({ tenantId }).session(session);
  const [order] = await EcommerceOrder.create([{
    _id: orderId,
    tenantId,
    customerId: booking.customerId,
    orderNumber: `EC-${createId("ordn").slice(-10).toUpperCase()}`,
    status: EcommerceOrderStatus.PAID,
    bookingId: booking._id,
    lines: fb.lines,
    fulfilmentMode: booking.fulfilmentMode,
    pickupBranchId: booking.pickupBranchId,
    subtotalPaise: fb.subtotalPaise,
    taxPaise: fb.taxPaise,
    fulfilmentChargePaise: fb.fulfilmentChargePaise,
    totalPaise: fb.totalPaise,
    taxConfigVersion: fb.financialSnapshot?.catalogTaxSettingsVersion,
    financialSnapshot: { ...fb.financialSnapshot, bookingId: booking._id, bookingNumber: booking.bookingNumber },
    paymentMethod: EcommercePaymentMethod.ONLINE,
    paidAt: at,
    successfulPaymentAttemptId: (balanceAttempt ?? { _id: booking.advance.attemptId })._id,
    paymentAllocations: allocations,
    storePolicySnapshot: snapshotStorePolicyForOrder(fulfilmentRow?.toObject?.() ?? fulfilmentRow ?? {}),
  }], { session });

  await EcommercePaymentAttempt.updateMany(
    { tenantId, _id: { $in: allocations.map((a) => a.paymentAttemptId) } },
    { $set: { orderId } },
    { session },
  );
  await transferBookingHoldsToOrder({ tenantId, bookingId: booking._id, orderId, expiresAt: at, session });
  await consumeOrderStockReservationsOnce({ tenantId, orderId, session, at });

  const converted = await EcommerceBooking.findOneAndUpdate(
    { _id: booking._id, tenantId, status: { $in: [EcommerceBookingStatus.CONFIRMED, EcommerceBookingStatus.BALANCE_PENDING] }, convertedOrderId: { $exists: false } },
    {
      $set: {
        status: EcommerceBookingStatus.CONVERTED,
        paymentStatus: EcommerceBookingPaymentStatus.FULLY_PAID,
        convertedOrderId: orderId,
        convertedAt: at,
        expiryAt: null,
        ...(balanceAttempt ? { "balance.capturedPaise": balanceAttempt.amountPaise, "balance.attemptId": balanceAttempt._id, "balance.capturedAt": at } : {}),
        ...(fb.excessAdvancePaise ? { refundStatus: EcommerceBookingRefundStatus.PENDING } : {}),
      },
      $inc: { version: 1 },
    },
    { session, new: true },
  ).lean();
  if (!converted) throw conflict("BOOKING_CHANGED", "The booking changed during conversion.");

  if (fb.excessAdvancePaise) {
    await reserveCaptureRefund({
      tenantId,
      paymentAttemptId: booking.advance.attemptId,
      amountPaise: fb.excessAdvancePaise,
      operationId: `booking-excess:${booking._id}`,
      refundSource: EcommerceOrderRefundSource.BOOKING_EXCESS_ADVANCE,
      orderId,
      session,
    });
  }
  await EcommerceOrderEvent.create([
    {
      _id: createId("eoev"), tenantId, orderId, type: EcommerceOrderEventType.ORDER_CREATED,
      actorType: actorId ? "STAFF" : "SYSTEM", actorId, payload: { bookingId: booking._id },
    },
    {
      _id: createId("eoev"), tenantId, orderId, type: EcommerceOrderEventType.PAYMENT_SUCCEEDED,
      actorType: "SYSTEM", payload: { bookingId: booking._id, allocations },
    },
  ], { session, ordered: true });
  await enqueueEcommerceOutboxEvent({
    tenantId,
    topic: ECOMMERCE_OUTBOX_TOPICS.PAYMENT_SUCCEEDED,
    key: `${orderId}:${order.successfulPaymentAttemptId}:booking-conversion`,
    payload: { orderId, paymentAttemptId: order.successfulPaymentAttemptId, source: "BOOKING_CONVERSION" },
    session,
  });
  return { booking: converted, order: order.toObject() };
}

async function onCaptured({ attempt, session }) {
  const { tenantId, bookingId } = attempt;
  const booking = await EcommerceBooking.findOne({ _id: bookingId, tenantId }).session(session).lean();
  if (!booking) return { accepted: false, reason: "BOOKING_NOT_FOUND" };
  const at = new Date();

  if (attempt.purpose === EcommercePaymentPurpose.BOOKING_ADVANCE) {
    if (booking.status !== EcommerceBookingStatus.PENDING_ADVANCE) return { accepted: false, reason: "BOOKING_NOT_OPEN_FOR_ADVANCE" };
    if (booking.advance.capturedPaise > 0) return { accepted: false, reason: "BOOKING_ALREADY_FUNDED" };
    if (attempt.amountPaise !== booking.advance.requiredPaise) return { accepted: false, reason: "BOOKING_AMOUNT_MISMATCH" };
    const hold = await EcommerceStockReservation.findOne({ ...bookingHoldFilter(tenantId, bookingId) }).session(session).lean();
    if (!hold) return { accepted: false, reason: "BOOKING_HOLD_MISSING" };
    const { balanceDueAt, rateProtectedUntil } = confirmedDeadlines(booking.policy.snapshot, at);
    const updated = await EcommerceBooking.findOneAndUpdate(
      { _id: bookingId, tenantId, status: EcommerceBookingStatus.PENDING_ADVANCE, "advance.capturedPaise": 0, version: booking.version },
      {
        $set: {
          status: EcommerceBookingStatus.CONFIRMED,
          paymentStatus: EcommerceBookingPaymentStatus.ADVANCE_PAID,
          "advance.capturedPaise": attempt.amountPaise,
          "advance.attemptId": attempt._id,
          "advance.capturedAt": at,
          confirmedAt: at,
          balanceDueAt,
          expiryAt: balanceDueAt,
          expiryRetryAt: null,
          expiryDeferrals: 0,
          ...(booking.bookedRate?.ratePerGramPaise ? { "bookedRate.protectedUntil": rateProtectedUntil } : {}),
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    ).lean();
    return updated ? { accepted: true } : { accepted: false, reason: "BOOKING_CHANGED" };
  }

  if (attempt.purpose === EcommercePaymentPurpose.BOOKING_BALANCE) {
    if (booking.status !== EcommerceBookingStatus.BALANCE_PENDING) return { accepted: false, reason: "BOOKING_NOT_AWAITING_BALANCE" };
    if (attempt.amountPaise !== booking.finalBilling?.balancePaise) return { accepted: false, reason: "BOOKING_AMOUNT_MISMATCH" };
    try {
      await convertBookingToOrderInTx({ booking, balanceAttempt: attempt, at, session });
    } catch (error) {
      // The throw rolls this payment transaction back and the gateway retries, so the customer's
      // money is not lost, but nothing would tell staff the booking cannot convert. Raise the alert
      // outside the transaction so it survives the rollback.
      await upsertOperationalAlert({
        tenantId,
        type: AlertType.PAYMENT_REVIEW,
        entityId: bookingId,
        title: "Booking balance captured but conversion failed",
        message: "The balance was paid but the booking could not be converted to an order. The gateway will retry; investigate if this persists.",
        branchId: booking.pickupBranchId,
        metadata: { bookingId, paymentAttemptId: attempt._id, error: error?.code ?? error?.message ?? "UNKNOWN" },
      }).catch(() => {});
      throw error;
    }
    // A retry that converts clears the alert an earlier failed attempt raised.
    await resolveOperationalAlert({ tenantId, type: AlertType.PAYMENT_REVIEW, entityId: bookingId, session });
    return { accepted: true };
  }
  return { accepted: false, reason: "BOOKING_PURPOSE_UNKNOWN" };
}

async function onFailed({ attempt, reason, session }) {
  await EcommerceBooking.updateOne(
    { _id: attempt.bookingId, tenantId: attempt.tenantId },
    { $set: { lastPaymentFailure: { attemptId: attempt._id, purpose: attempt.purpose, reason, at: new Date() } } },
    { session },
  );
}

async function recomputeBookingRefundStatus({ refund, session }) {
  await recomputeBookingRefundStatusFor({ tenantId: refund.tenantId, bookingId: refund.bookingId, session });
}

const onRefundSettled = recomputeBookingRefundStatus;
async function onRefundFailed({ refund, session }) {
  await recomputeBookingRefundStatus({ refund, session });
}

/**
 * What a customer sees before booking: the policy that applies, its terms and the advance for the
 * current price. Nothing is created or held. The policy version id returned is what the customer
 * must send back as accepted.
 */
export async function previewBooking({ tenantId, productId, pickupBranchId, at = new Date() }) {
  const product = await assertBookable({ tenantId, productId, pickupBranchId, session: null });
  const { policy } = await resolveBookingPolicy({ tenantId, product, pickupBranchId });
  const context = await loadBookingPricingContext({ tenantId, pickupBranchId });
  const liveRateRow = product.priceMode === "FIXED" ? null : await latestRateForPurity(tenantId, product.purity);
  const quoted = priceBookingInvoice({
    product, context, stage: "ADVANCE_QUOTE", liveRateRow, stockPolicy: EcommerceStockPolicy.QUANTITY_TRACKED, at,
  });
  // The same sellable-units-minus-effective-holds figure the hold itself checks at creation.
  const stock = await loadInventoryAvailability(tenantId, productId);
  if (stock.stockPolicy !== EcommerceStockPolicy.QUANTITY_TRACKED) {
    throw errors.business("BOOKING_SKU_NOT_TRACKED", "Only quantity-tracked pieces can be booked.", { productId });
  }
  if ((stock.quantityOnHand ?? 0) < 1) {
    throw errors.business("INSUFFICIENT_STOCK", "This piece is sold out.", { productId });
  }
  const availableQuantity = stock.availableQuantity ?? 0;
  return {
    productId,
    pickupBranchId,
    policyVersionId: policy._id,
    estimateTotalPaise: quoted.totalPaise,
    ratePerGramPaise: liveRateRow?.ratePerGramPaise ?? null,
    advanceRequiredPaise: computeAdvancePaise(policy, quoted.totalPaise),
    advanceWindowMinutes: policy.advanceWindowMinutes,
    balanceWindowHours: policy.balanceWindowHours,
    rateRule: policy.rateRule,
    rateProtectionHours: policy.rateProtectionHours,
    // Protection and the balance deadline both start when the advance is paid.
    rateProtectionEndsBeforeBalanceDeadline: bookingRateProtectionEndsEarly(policy),
    cancellationFeeBps: policy.cancellationFeeBps ?? 0,
    termsText: policy.terms?.text ?? "",
    availableQuantity,
    heldByOthers: availableQuantity < 1,
  };
}

/** Install the real booking handlers on the payment layer. Call once at API and worker start-up. */
export function installBookingPaymentHandlers() {
  registerBookingPaymentHandlers({ onCaptured, onFailed, onRefundSettled, onRefundFailed });
}
