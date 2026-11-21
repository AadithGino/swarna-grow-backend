import { createId } from "../lib/ids.js";
import { AppError, errors } from "../lib/app-error.js";
import { assertEcommerceOperational } from "../lib/ecommerce-access.js";
import { tenantForEcommerceCheckout } from "../lib/ecommerce-checkout-tenant.js";
import { assertCustomerPaymentAllowed } from "../lib/ecommerce-checkout-capability.js";
import { assertBookingPaymentsEnabled } from "../lib/ecommerce-booking-flags.js";
import { resolvePhonePeCredentials } from "../integrations/phonepe.provider.js";
import { initiatePhonePeCustomerCheckout } from "../lib/phonepe-customer-checkout-init.js";
import {
  mapPhonePeCustomerCheckoutResponse,
  mergePhonePeProviderInitPayload,
  PhonePePersistedCheckoutChannel,
  readPersistedPhonePeCheckoutRedirectUrl,
} from "../lib/phonepe-customer-web-checkout.js";
import {
  EcommerceBookingStatus,
  EcommercePaymentAttemptOperationalStatus,
  EcommercePaymentAttemptStatus,
} from "../constants/enums.js";
import { EcommerceBooking, EcommercePaymentAttempt } from "../models/index.js";
import { loadPaymentCapability } from "./ecommerce-payment-intent.service.js";
import { renewBookingPaymentAttempt } from "./ecommerce-booking.service.js";

const CLAIM_MS = 5 * 60_000;
const INITIATABLE = [EcommercePaymentAttemptStatus.PENDING, EcommercePaymentAttemptStatus.INITIATED];

export function mapBookingPaymentIntent(row, booking) {
  return {
    id: row._id,
    bookingId: row.bookingId,
    purpose: row.purpose,
    status: row.status,
    amountPaise: row.amountPaise,
    currency: row.currency ?? "INR",
    providerOrderId: row.providerOrderId ?? null,
    merchantOrderId: row.merchantOrderId ?? row._id,
    redirectUrl: row.redirectUrl ?? null,
    ...mapPhonePeCustomerCheckoutResponse(row),
    expiresAt: row.expiresAt ?? null,
    bookingStatus: booking?.status ?? null,
    statusPollUrl: `/app/shop/bookings/${row.bookingId}/payment-intents/${row._id}`,
    failureReason: row.failureReason ?? null,
    operationalStatus: row.operationalStatus ?? null,
  };
}

const hasCheckout = (row) => Boolean(row?.providerOrderId && (readPersistedPhonePeCheckoutRedirectUrl(row) || row.sdkToken));

/**
 * Start (or resume) the provider checkout for the booking's current payment: the advance while the
 * booking waits for it, the balance once it is billed. The attempt comes from renewBookingPaymentAttempt,
 * which returns the active attempt or creates a new one only after the earlier attempt ended, so one
 * provider order is only ever created for one attempt and a retry never re-points an attempt.
 *
 * Initiation follows the order checkout: a claim token fences concurrent callers, and an error after
 * the provider may have been reached marks the attempt INITIATION_UNCERTAIN so reconcile (and expiry)
 * poll it instead of treating it as unpaid.
 */
export async function initiateBookingPayment({
  tenant, tenantId, customerId, bookingId, redirectUrl, clientPlatform, checkoutChannel, at = new Date(),
}) {
  assertBookingPaymentsEnabled();
  assertEcommerceOperational(tenant);
  assertCustomerPaymentAllowed(await loadPaymentCapability(tenantId, tenant));
  if (!redirectUrl) throw errors.validation([{ field: "redirectUrl", message: "redirectUrl is required." }]);

  const { attempt } = await renewBookingPaymentAttempt({ tenantId, bookingId, customerId, at });
  const booking = await EcommerceBooking.findOne({ _id: bookingId, tenantId, customerId }).lean();
  if (!booking) throw errors.notFound("Booking");
  if (![EcommerceBookingStatus.PENDING_ADVANCE, EcommerceBookingStatus.BALANCE_PENDING].includes(booking.status)) {
    throw errors.conflict("BOOKING_NOT_PAYABLE", "This booking is not waiting for a payment.", { status: booking.status });
  }
  return startBookingAttemptCheckout({ tenantId, attempt, booking, redirectUrl, clientPlatform, checkoutChannel });
}

/**
 * The claim-and-provider half of initiation, after the capability checks. Exported so it can be
 * exercised with the provider mocked, without a fully configured tenant.
 */
export async function startBookingAttemptCheckout({
  tenantId, attempt, booking, redirectUrl, clientPlatform, checkoutChannel,
}) {
  if (attempt.status === EcommercePaymentAttemptStatus.INITIATED && hasCheckout(attempt)) {
    return { paymentIntent: mapBookingPaymentIntent(attempt, booking), created: false };
  }

  const claimMarker = `CLAIM-${createId("claim")}`;
  const claimed = await EcommercePaymentAttempt.findOneAndUpdate(
    {
      _id: attempt._id,
      tenantId,
      status: { $in: INITIATABLE },
      providerOrderId: { $in: [null, ""] },
      // An earlier initiation may have reached the provider. Reconcile resolves it; starting another
      // provider order for the same attempt could charge the customer twice.
      initiationUncertainAt: null,
      $or: [
        { initiationClaimToken: null },
        { initiationClaimToken: { $exists: false } },
        { initiationClaimExpiresAt: { $lte: new Date() } },
      ],
    },
    { $set: { initiationClaimToken: claimMarker, initiationClaimExpiresAt: new Date(Date.now() + CLAIM_MS), redirectUrl } },
    { new: true },
  );
  if (!claimed) {
    const fresh = await EcommercePaymentAttempt.findById(attempt._id).lean();
    if (hasCheckout(fresh)) return { paymentIntent: mapBookingPaymentIntent(fresh, booking), created: false };
    if (fresh?.initiationUncertainAt) {
      throw errors.business(
        "PAYMENT_INITIATION_UNCERTAIN",
        "Payment may have started at the provider. Check the booking status shortly.",
        { paymentAttemptId: attempt._id },
      );
    }
    const claimActive = fresh?.initiationClaimToken && fresh.initiationClaimExpiresAt
      && new Date(fresh.initiationClaimExpiresAt) > new Date();
    throw errors.business(
      claimActive ? "PAYMENT_INITIATION_IN_PROGRESS" : "PAYMENT_INITIATION_UNAVAILABLE",
      claimActive ? "Payment initiation is already in progress for this booking." : "This payment cannot be started right now.",
      { paymentAttemptId: attempt._id },
    );
  }

  const credentials = resolvePhonePeCredentials(await tenantForEcommerceCheckout(tenantId));
  try {
    const provider = await initiatePhonePeCustomerCheckout({
      merchantOrderId: claimed.merchantOrderId ?? claimed._id,
      amountPaise: claimed.amountPaise,
      redirectUrl: claimed.redirectUrl ?? redirectUrl,
      credentials,
      tenantId,
      clientPlatform,
      checkoutChannel,
    });
    await EcommercePaymentAttempt.updateOne(
      { _id: claimed._id, initiationClaimToken: claimMarker, status: { $in: INITIATABLE } },
      {
        $set: {
          status: EcommercePaymentAttemptStatus.INITIATED,
          providerOrderId: provider.providerOrderId,
          merchantOrderId: provider.merchantOrderId ?? claimed.merchantOrderId ?? claimed._id,
          sdkToken: provider.phonePeCheckoutChannel === PhonePePersistedCheckoutChannel.SDK_ORDER ? provider.token ?? null : null,
          providerPayload: mergePhonePeProviderInitPayload(claimed.providerPayload, {
            checkoutChannel: provider.phonePeCheckoutChannel,
            provider,
          }),
          providerInitConfirmedAt: new Date(),
          operationalStatus: EcommercePaymentAttemptOperationalStatus.AWAITING_PROVIDER,
          gatewayReconcileNextAt: new Date(Date.now() + 60_000),
        },
        $unset: { initiationClaimToken: "", initiationClaimExpiresAt: "" },
        $inc: { version: 1 },
      },
    );
    const fresh = await EcommercePaymentAttempt.findById(claimed._id).lean();
    return { paymentIntent: mapBookingPaymentIntent(fresh, booking), created: true };
  } catch (error) {
    await EcommercePaymentAttempt.updateOne(
      { _id: claimed._id, initiationClaimToken: claimMarker },
      {
        $set: {
          operationalStatus: EcommercePaymentAttemptOperationalStatus.INITIATION_UNCERTAIN,
          initiationUncertainAt: new Date(),
          failureReason: "PROVIDER_INITIATION_UNCERTAIN",
          gatewayReconcileNextAt: new Date(),
        },
        $unset: { initiationClaimToken: "", initiationClaimExpiresAt: "" },
        $inc: { version: 1 },
      },
    );
    if (error instanceof AppError) throw error;
    throw errors.business(
      "PAYMENT_INITIATION_UNCERTAIN",
      "Payment may have started at the provider. Check the booking status shortly.",
      { paymentAttemptId: claimed._id },
    );
  }
}

/** Customer poll for one payment of their booking. */
export async function getBookingPaymentIntent({ tenantId, customerId, bookingId, paymentAttemptId }) {
  const booking = await EcommerceBooking.findOne({ _id: bookingId, tenantId, customerId }).lean();
  if (!booking) throw errors.notFound("Booking");
  const attempt = await EcommercePaymentAttempt.findOne({ _id: paymentAttemptId, tenantId, bookingId }).lean();
  if (!attempt) throw errors.notFound("Payment attempt");
  return mapBookingPaymentIntent(attempt, booking);
}
