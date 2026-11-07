import { PaymentIntent, PaymentLink } from "../models/index.js";
import { isFixedReservationIntent } from "./fixed-payment-reservation.js";

/** Merchant order id embedded in pending receipt numbers (`PENDING-<ref>`). */
export function pendingReceiptMerchantRef(receiptNumber) {
  return receiptNumber?.match(/^PENDING-(.+)$/)?.[1] ?? null;
}

function samePaymentBinding(row, payment) {
  return row?.paymentId && payment?._id && String(row.paymentId) === String(payment._id);
}

function sameTenant(row, payment) {
  return row?.tenantId && payment?.tenantId && String(row.tenantId) === String(payment.tenantId);
}

function boundLink(link, payment) {
  return link && samePaymentBinding(link, payment) && sameTenant(link, payment) ? link : null;
}

function boundIntent(intent, payment) {
  return intent && samePaymentBinding(intent, payment) && sameTenant(intent, payment) ? intent : null;
}

/**
 * PhonePe merchant order id implied by bound checkout rows (one checkout, not every linked record).
 */
export function inferGatewayMerchantOrderIdFromCheckoutFlow(payment, { intent = null, link = null } = {}) {
  const bl = boundLink(link, payment);
  const bi = boundIntent(intent, payment);
  const stored = payment?.gatewayMerchantOrderId ? String(payment.gatewayMerchantOrderId) : null;
  if (bl) return String(bl._id);
  if (bi) {
    if (isFixedReservationIntent(bi)) {
      if (stored && stored === String(bi._id)) return stored;
      return null;
    }
    return String(bi._id);
  }
  return null;
}

function verifiedPendingReceiptRef(payment, { intent = null, link = null } = {}) {
  const receiptRef = pendingReceiptMerchantRef(payment.receiptNumber);
  if (!receiptRef) return null;
  const bl = boundLink(link, payment);
  const bi = boundIntent(intent, payment);
  if (bl && String(bl._id) === receiptRef) return receiptRef;
  if (bi && String(bi._id) === receiptRef) {
    if (isFixedReservationIntent(bi)) {
      const stored = payment?.gatewayMerchantOrderId ? String(payment.gatewayMerchantOrderId) : null;
      return stored === receiptRef ? receiptRef : null;
    }
    return receiptRef;
  }
  return null;
}

/**
 * Collect verified merchant-order candidates (never provider order / txn ids).
 * @returns {{ candidates: string[], ambiguous: boolean, review: object | null }}
 */
export function collectGatewayMerchantOrderIdCandidates(payment, { intent = null, link = null } = {}) {
  if (!payment) return { candidates: [], ambiguous: false, review: null };

  const inferred = inferGatewayMerchantOrderIdFromCheckoutFlow(payment, { intent, link });
  const stored = payment.gatewayMerchantOrderId ? String(payment.gatewayMerchantOrderId) : null;
  const receiptVerified = verifiedPendingReceiptRef(payment, { intent, link });

  const candidates = new Set();
  if (stored) candidates.add(stored);
  if (inferred) candidates.add(inferred);
  if (receiptVerified) candidates.add(receiptVerified);

  const list = [...candidates];
  const receiptRef = pendingReceiptMerchantRef(payment.receiptNumber);
  const bi = boundIntent(intent, payment);
  if (
    list.length === 0
    && receiptRef
    && bi
    && isFixedReservationIntent(bi)
    && String(bi._id) === receiptRef
    && !stored
  ) {
    return {
      candidates: [],
      ambiguous: true,
      review: {
        reason: "UNVERIFIED_FIXED_RESERVATION_RECEIPT",
        receiptRef,
        intentId: String(bi._id),
      },
    };
  }
  if (list.length <= 1) {
    return { candidates: list, ambiguous: false, review: null };
  }

  const review = {
    reason: "MERCHANT_REFERENCE_AMBIGUOUS",
    stored,
    inferred,
    receiptVerified,
    candidateIds: list,
  };
  return { candidates: list, ambiguous: true, review };
}

export function resolveGatewayMerchantOrderIdFromRows(payment, context = {}) {
  const { candidates, ambiguous } = collectGatewayMerchantOrderIdCandidates(payment, context);
  if (ambiguous) return null;
  return candidates[0] ?? null;
}

async function loadBoundPaymentLinks(tenantId, paymentId) {
  return PaymentLink.find({ tenantId, paymentId })
    .select("_id tenantId paymentId")
    .lean();
}

async function loadBoundPaymentIntents(tenantId, paymentId) {
  return PaymentIntent.find({ tenantId, paymentId })
    .select("_id tenantId paymentId fixedFromInstallment fixedThroughInstallment providerOrderId")
    .lean();
}

/**
 * Canonical async resolver for status polling, reconciliation, and refunds.
 * Ambiguous or unbound legacy rows return null (callers must fail safely).
 */
export async function resolveGatewayMerchantOrderIdForPayment(payment) {
  if (!payment) return null;

  const links = await loadBoundPaymentLinks(payment.tenantId, payment._id);
  if (links.length > 1) return null;

  const intents = await loadBoundPaymentIntents(payment.tenantId, payment._id);
  if (intents.length > 1) return null;

  let intent = intents[0] ?? null;
  let link = links[0] ?? null;

  const receiptRef = pendingReceiptMerchantRef(payment.receiptNumber);
  if (receiptRef) {
    const receiptLink = await PaymentLink.findOne({
      tenantId: payment.tenantId,
      _id: receiptRef,
      paymentId: payment._id,
    })
      .select("_id tenantId paymentId")
      .lean();
    const receiptIntent = await PaymentIntent.findOne({
      tenantId: payment.tenantId,
      _id: receiptRef,
      paymentId: payment._id,
    })
      .select("_id tenantId paymentId fixedFromInstallment")
      .lean();
    if (receiptLink) link = receiptLink;
    if (receiptIntent) intent = receiptIntent;
  }

  return resolveGatewayMerchantOrderIdFromRows(payment, { intent, link });
}

/** PhonePe dashboard + webhook correlation id (max 80 chars in our schemas). */
export const PHONEPE_MERCHANT_ORDER_ID_MAX_LENGTH = 80;

/** Normalize id sent to PhonePe `merchantOrderId` (must match stored gatewayMerchantOrderId). */
export function normalizePhonePeMerchantOrderId(merchantOrderId) {
  const value = String(merchantOrderId ?? "").trim();
  if (!value) {
    const err = new Error("PhonePe merchantOrderId is required.");
    err.code = "PHONEPE_MERCHANT_ORDER_ID_REQUIRED";
    throw err;
  }
  if (value.length > PHONEPE_MERCHANT_ORDER_ID_MAX_LENGTH) {
    const err = new Error(
      `PhonePe merchantOrderId exceeds ${PHONEPE_MERCHANT_ORDER_ID_MAX_LENGTH} characters.`,
    );
    err.code = "PHONEPE_MERCHANT_ORDER_ID_TOO_LONG";
    throw err;
  }
  return value;
}

/** Write-once initiation reference (PhonePe merchantOrderId). */
export function gatewayMerchantOrderIdForInitiation(merchantOrderId) {
  if (merchantOrderId == null || merchantOrderId === "") return null;
  return normalizePhonePeMerchantOrderId(merchantOrderId);
}

/** $set patch for first write only; returns {} when already set to the same value. */
export function gatewayMerchantOrderIdWritePatch(existingPayment, merchantOrderId) {
  const value = gatewayMerchantOrderIdForInitiation(merchantOrderId);
  if (!value) return {};
  const existing = existingPayment?.gatewayMerchantOrderId;
  if (existing != null && existing !== "") {
    if (String(existing) !== value) {
      const err = new Error(
        `gatewayMerchantOrderId is write-once (existing ${existing}, attempted ${value})`,
      );
      err.code = "GATEWAY_MERCHANT_ORDER_ID_CONFLICT";
      throw err;
    }
    return {};
  }
  return { gatewayMerchantOrderId: value };
}
