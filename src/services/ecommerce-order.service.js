import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { assertEcommerceOperational } from "../lib/ecommerce-access.js";
import { evaluateCheckoutTaxReadiness } from "../lib/ecommerce-checkout-tax.js";
import {
  assertCustomerOrderCreationAllowed,
  deriveEcommerceCheckoutCapability,
} from "../lib/ecommerce-checkout-capability.js";
import { tenantForEcommerceCheckout } from "../lib/ecommerce-checkout-tenant.js";
import { computeCodAcceptanceExpiresAt } from "../lib/ecommerce-cod-pending-policy.js";
import { evaluateCodEligibility, orderUsesCod } from "../lib/ecommerce-cod.js";
import {
  initialCourierCodForOrder,
  isCourierCodBankReconciled,
  isCourierCodCollectionConfirmed,
} from "../lib/ecommerce-courier-cod.js";
import { attachAdminOrderCourierPresentation } from "../lib/ecommerce-admin-order-courier-presentation.js";
import { findActivePaymentAttempt } from "../lib/ecommerce-payment-in-flight.js";
import { mapCustomerActivePaymentAttempt } from "./ecommerce-payment-intent.service.js";
import { testPaymentHarnessMetaForClient } from "./ecommerce-test-payment-completion.service.js";
import { computePendingPaymentExpiresAt } from "../lib/ecommerce-pending-payment-policy.js";
import { snapshotStorePolicyForOrder } from "../lib/ecommerce-store-policies.js";
import { isEcommerceOrderInvoiceAvailable } from "../lib/ecommerce-order-invoice-eligibility.js";
import { paginate } from "../lib/pagination.js";
import { listAdminOrdersPaginated } from "./ecommerce-admin-order-list.service.js";
import { attachAdminOrderCustomerDisplay } from "../lib/ecommerce-admin-order-customer-display.js";
import { attachReturnSummaryToAdminOrder } from "./ecommerce-admin-order-returns.service.js";
import {
  consumeActiveQuoteRow,
  expireActiveQuoteRow,
  transferQuoteReservationsToOrder,
} from "../lib/ecommerce-quote-lifecycle.js";
import { revalidateQuoteForOrder } from "../lib/ecommerce-quote-revalidation.js";
import { hashIdempotencyBody } from "./idempotency.service.js";
import {
  EcommerceFulfilmentSettings,
  EcommerceOrder,
  EcommerceOrderEvent,
  EcommercePaymentExceptionRefund,
  EcommercePriceQuote,
  EcommerceTaxSettings,
} from "../models/index.js";
import {
  EcommerceFulfilmentMode,
  EcommerceOrderEventType,
  EcommerceOrderStatus,
  EcommercePaymentExceptionRefundStatus,
  EcommercePaymentMethod,
  EcommerceQuoteStatus,
} from "../constants/enums.js";

function mapRefundPresentation(refundRow) {
  if (!refundRow) {
    return {
      refundStatus: "NONE",
      refundStatusLabel: null,
      refundProviderReference: null,
    };
  }
  const status = refundRow.status;
  if (
    status === EcommercePaymentExceptionRefundStatus.SUCCEEDED
    || status === EcommercePaymentExceptionRefundStatus.MANUAL_RECORDED
  ) {
    return {
      refundStatus: "REFUNDED",
      refundStatusLabel: "Refund confirmed",
      refundProviderReference: refundRow.providerRefundId ?? null,
    };
  }
  if (status === EcommercePaymentExceptionRefundStatus.FAILED) {
    return {
      refundStatus: "REFUND_FAILED",
      refundStatusLabel: "Refund failed at provider — staff is resolving",
      refundProviderReference: refundRow.providerRefundId ?? null,
    };
  }
  if (
    status === EcommercePaymentExceptionRefundStatus.PROVIDER_PENDING
    || status === EcommercePaymentExceptionRefundStatus.INITIATED
    || status === EcommercePaymentExceptionRefundStatus.ASSIGNED
  ) {
    return {
      refundStatus: "REFUND_PENDING",
      refundStatusLabel: "Refund in progress — not completed yet",
      refundProviderReference: refundRow.providerRefundId ?? null,
    };
  }
  return {
    refundStatus: "NONE",
    refundStatusLabel: null,
    refundProviderReference: null,
  };
}

function mapCustomerOrder(row, capability, refundRow, activePaymentAttempt = null) {
  const pending = row.status === EcommerceOrderStatus.PENDING_PAYMENT;
  const cod = orderUsesCod(row);
  const codPending = row.status === EcommerceOrderStatus.COD_PENDING_ACCEPTANCE;
  const codCollected = isCourierCodCollectionConfirmed(row);
  const codBankSettled = isCourierCodBankReconciled(row);
  const cap = capability ?? {
    paymentAllowed: false,
    checkoutUsable: false,
    checkoutTaxReady: false,
  };
  const paymentMethod = row.paymentMethod ?? EcommercePaymentMethod.ONLINE;
  let statusLabel = String(row.status);
  if (pending) statusLabel = "Awaiting payment — not charged";
  else if (row.status === EcommerceOrderStatus.PAYMENT_EXPIRED) {
    statusLabel = "Payment window expired — not charged";
  } else if (codPending) {
    statusLabel = "Awaiting jeweller acceptance — payment due on delivery";
  } else if (cod && !codCollected) {
    statusLabel = "Payment due on delivery";
  }
  return {
    id: row._id,
    orderNumber: row.orderNumber,
    status: row.status,
    statusLabel,
    paymentMethod,
    codPincodeSnapshot: row.codPincodeSnapshot ?? null,
    courierCodCollectionStatus: cod ? row.courierCod?.collectionStatus ?? null : null,
    courierCodRemittanceStatus: cod ? row.courierCod?.remittanceStatus ?? null : null,
    codBankRemittanceReconciled: cod ? codBankSettled : null,
    paymentAllowed: cod ? false : cap.paymentAllowed,
    orderPlacementAllowed: false,
    paymentCompleted: cod ? codCollected : row.status === EcommerceOrderStatus.PAID,
    checkoutUsable: cap.checkoutUsable,
    quoteId: row.quoteId ?? null,
    lines: row.lines ?? [],
    fulfilmentMode: row.fulfilmentMode ?? null,
    pickupBranchId: row.pickupBranchId ?? null,
    addressSnapshot: row.addressSnapshot ?? null,
    subtotalPaise: row.subtotalPaise ?? 0,
    taxPaise: row.taxPaise ?? 0,
    fulfilmentChargePaise: row.fulfilmentChargePaise ?? 0,
    totalPaise: row.totalPaise ?? 0,
    financialSnapshot: row.financialSnapshot ?? {},
    expiresAt: row.expiresAt ?? null,
    createdAt: row.createdAt ?? null,
    version: row.version ?? 1,
    paymentExceptionStatus: row.paymentExceptionStatus ?? null,
    fulfilmentStatus:
      row.status === EcommerceOrderStatus.PAID
      || row.status === EcommerceOrderStatus.PROCESSING
      || row.status === EcommerceOrderStatus.READY_FOR_PICKUP
      || row.status === EcommerceOrderStatus.SHIPPED
      || row.status === EcommerceOrderStatus.DELIVERED
      || row.status === EcommerceOrderStatus.CANCELLED
        ? row.status
        : null,
    ...mapRefundPresentation(refundRow),
    activePaymentAttempt: cod ? null : activePaymentAttempt,
    testPaymentHarness: cod ? null : testPaymentHarnessMetaForClient(),
    invoiceAvailable: isEcommerceOrderInvoiceAvailable(row),
    deliveryTracking:
      row.fulfilmentMode === EcommerceFulfilmentMode.DELIVERY
        ? {
            carrierName: row.deliveryTracking?.carrierName ?? "",
            trackingNumber: row.deliveryTracking?.trackingNumber ?? "",
            trackingUrl: row.deliveryTracking?.trackingUrl ?? "",
            dispatchedAt: row.deliveryTracking?.dispatchedAt ?? null,
            deliveredAt: row.deliveryTracking?.deliveredAt ?? null,
          }
        : null,
    storePolicySnapshot: row.storePolicySnapshot ?? null,
  };
}

function mapAdminOrder(row, capability, refundRow) {
  return {
    ...mapCustomerOrder(row, capability, refundRow),
    customerId: row.customerId,
    stockReleaseReason: row.stockReleaseReason ?? null,
    stockReleasedAt: row.stockReleasedAt ?? null,
    paidAt: row.paidAt ?? null,
    successfulPaymentAttemptId: row.successfulPaymentAttemptId ?? null,
    channel: row.assisted?.byUserId ? "COUNTER" : "ONLINE",
    assisted: row.assisted?.byUserId
      ? {
          byUserId: row.assisted.byUserId,
          paymentMode: row.assisted.paymentMode ?? null,
          paymentReference: row.assisted.paymentReference ?? "",
          recordedAt: row.assisted.recordedAt ?? null,
        }
      : null,
  };
}

async function loadCheckoutContext(tenantId, tenantFromRequest) {
  const tenant = await tenantForEcommerceCheckout(tenantId, tenantFromRequest);
  const fulfilmentRow = await EcommerceFulfilmentSettings.findOne({ tenantId }).lean();
  const taxSettings = await EcommerceTaxSettings.findOne({ tenantId }).lean();
  const capability = deriveEcommerceCheckoutCapability({
    taxSettings,
    fulfilmentSettingsRow: fulfilmentRow ?? {},
    tenant,
  });
  return { fulfilmentRow, taxSettings, capability };
}

async function loadExistingOrderByIdempotency(req, bodyHash, capability) {
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  const row = await EcommerceOrder.findOne({
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
    idempotencyKey,
  }).lean();
  if (!row) return null;
  if (row.creationBodyHash && row.creationBodyHash !== bodyHash) {
    throw errors.conflict(
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was already used with a different request.",
    );
  }
  return { order: mapCustomerOrder(row, capability), created: false };
}

/**
 * @param {object} req  customer-bound request
 * @param {{ assisted?: object }} [opts]  staff counter order: payment is taken in store, so the
 *   online-gateway requirement is skipped and the order records who placed it
 */
export async function createCustomerOrder(req, opts = {}) {
  assertEcommerceOperational(req.tenant);
  const { fulfilmentRow, taxSettings, capability: baseCapability } = await loadCheckoutContext(
    req.auth.tenantId,
    req.tenant,
  );

  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
  }
  const bodyHash = hashIdempotencyBody(req.body);
  const quoteId = String(req.body.quoteId ?? "").trim();
  if (!quoteId) {
    throw errors.validation([{ field: "quoteId", message: "quoteId is required." }]);
  }

  const early = await loadExistingOrderByIdempotency(req, bodyHash, baseCapability);
  if (early) return early;

  try {
    return await withTransaction(async (session) => {
      const dup = await EcommerceOrder.findOne({
        tenantId: req.auth.tenantId,
        customerId: req.auth.id,
        idempotencyKey,
      }).session(session);
      if (dup) {
        if (dup.creationBodyHash && dup.creationBodyHash !== bodyHash) {
          throw errors.conflict(
            "IDEMPOTENCY_KEY_REUSED",
            "This idempotency key was already used with a different request.",
          );
        }
        return { order: mapCustomerOrder(dup.toObject(), baseCapability), created: false };
      }

      let quote = await EcommercePriceQuote.findOne({
        _id: quoteId,
        tenantId: req.auth.tenantId,
        customerId: req.auth.id,
      }).session(session);
      if (!quote) throw errors.notFound("Quote");

      if (quote.status === EcommerceQuoteStatus.CONSUMED && quote.orderId) {
        const linked = await EcommerceOrder.findOne({
          _id: quote.orderId,
          tenantId: req.auth.tenantId,
        }).session(session);
        if (linked) {
          return { order: mapCustomerOrder(linked.toObject(), baseCapability), created: false };
        }
      }

      const paymentMethod = quote.paymentMethod ?? EcommercePaymentMethod.ONLINE;
      const tenantCheckout = await tenantForEcommerceCheckout(req.auth.tenantId, req.tenant);
      const codEvaluation = evaluateCodEligibility({
        tenant: tenantCheckout,
        taxSettings,
        fulfilmentSettingsRow: fulfilmentRow?.toObject?.() ?? fulfilmentRow ?? {},
        fulfilmentMode: quote.fulfilmentMode,
        addressSnapshot: quote.addressSnapshot,
      });
      const capability = {
        ...baseCapability,
        codOrderAllowed: codEvaluation.eligible,
        codBlockers: codEvaluation.blockers,
      };
      if (opts.assisted) {
        if (!capability.checkoutTaxReady) assertCustomerOrderCreationAllowed(capability, paymentMethod);
      } else {
        assertCustomerOrderCreationAllowed(capability, paymentMethod);
      }

      if (quote.status === EcommerceQuoteStatus.ACTIVE && new Date(quote.expiresAt) <= new Date()) {
        await expireActiveQuoteRow(quote._id, req.auth.tenantId, session);
        quote = await EcommercePriceQuote.findById(quote._id).session(session);
      }

      if (quote.status !== EcommerceQuoteStatus.ACTIVE) {
        throw errors.business("QUOTE_NOT_AVAILABLE", "Quote is not available for order creation.", {
          status: quote.status,
        });
      }

      const taxReadiness = evaluateCheckoutTaxReadiness(
        taxSettings,
        fulfilmentRow?.toObject?.() ?? fulfilmentRow ?? {},
      );
      if (!taxReadiness.ready) {
        throw new AppError(
          "CHECKOUT_NOT_READY",
          "Checkout tax and place-of-supply configuration is incomplete.",
          422,
          { blockers: taxReadiness.blockers },
        );
      }

      const validation = await revalidateQuoteForOrder({
        quoteRow: quote.toObject(),
        tenant: req.tenant,
        customerId: req.auth.id,
        session,
      });
      if (!validation.ok) {
        throw new AppError(
          "QUOTE_VALIDATION_FAILED",
          "Quote no longer matches current catalog, stock, tax, or fulfilment.",
          422,
          { blockers: validation.blockers },
        );
      }

      const orderId = createId("eord");
      const consumed = await consumeActiveQuoteRow({
        quoteId: quote._id,
        tenantId: req.auth.tenantId,
        customerId: req.auth.id,
        orderId,
        session,
      });
      if (!consumed) {
        throw errors.business("QUOTE_NOT_AVAILABLE", "Quote could not be consumed.", {
          quoteId: quote._id,
        });
      }

      const fulfilmentSettingsObj = fulfilmentRow?.toObject?.() ?? fulfilmentRow ?? {};
      const isCod = paymentMethod === EcommercePaymentMethod.COD;
      const orderExpiresAt = isCod
        ? computeCodAcceptanceExpiresAt(new Date(), fulfilmentSettingsObj)
        : computePendingPaymentExpiresAt(new Date(), fulfilmentSettingsObj);
      await transferQuoteReservationsToOrder({
        tenantId: req.auth.tenantId,
        quoteId: quote._id,
        orderId,
        session,
        expiresAt: orderExpiresAt,
      });

      const orderNumber = `EC-${createId("ordn").slice(-10).toUpperCase()}`;
      const financialSnapshot = {
        ...(quote.financialSnapshot?.toObject?.() ?? quote.financialSnapshot ?? {}),
        quoteId: quote._id,
        quoteFinancialSnapshot: quote.financialSnapshot,
        quoteLines: quote.lines,
        consumedAt: new Date().toISOString(),
        paymentMethod,
        codPincodeSnapshot: quote.codPincodeSnapshot ?? null,
        paymentExpiresAt: isCod ? null : orderExpiresAt.toISOString(),
        codAcceptanceExpiresAt: isCod ? orderExpiresAt.toISOString() : null,
      };

      const order = (
        await EcommerceOrder.create(
          [
            {
              _id: orderId,
              tenantId: req.auth.tenantId,
              customerId: req.auth.id,
              orderNumber,
              status: isCod
                ? EcommerceOrderStatus.COD_PENDING_ACCEPTANCE
                : EcommerceOrderStatus.PENDING_PAYMENT,
              quoteId: quote._id,
              lines: quote.lines,
              fulfilmentMode: quote.fulfilmentMode,
              pickupBranchId: quote.pickupBranchId,
              addressSnapshot: quote.addressSnapshot,
              subtotalPaise: quote.subtotalPaise,
              taxPaise: quote.taxPaise,
              fulfilmentChargePaise: quote.fulfilmentChargePaise,
              totalPaise: quote.totalPaise,
              taxConfigVersion: quote.taxConfigVersion,
              financialSnapshot,
              paymentMethod,
              codPincodeSnapshot: quote.codPincodeSnapshot ?? null,
              courierCod: isCod ? initialCourierCodForOrder({ totalPaise: quote.totalPaise }) : undefined,
              idempotencyKey,
              creationBodyHash: bodyHash,
              expiresAt: orderExpiresAt,
              storePolicySnapshot: snapshotStorePolicyForOrder(fulfilmentSettingsObj),
              ...(opts.assisted ? { assisted: opts.assisted } : {}),
            },
          ],
          { session },
        )
      )[0];

      await EcommerceOrderEvent.create(
        [
          {
            _id: createId("eoev"),
            tenantId: req.auth.tenantId,
            orderId: order._id,
            type: isCod ? EcommerceOrderEventType.COD_ORDER_PLACED : EcommerceOrderEventType.ORDER_CREATED,
            actorType: opts.assisted ? "STAFF" : "CUSTOMER",
            actorId: opts.assisted?.byUserId ?? req.auth.id,
            payload: {
              ...(opts.assisted ? { channel: "COUNTER", placedForCustomerId: req.auth.id } : {}),
              quoteId: quote._id,
              paymentMethod,
              paymentExpiresAt: isCod ? null : orderExpiresAt.toISOString(),
              codAcceptanceExpiresAt: isCod ? orderExpiresAt.toISOString() : null,
            },
          },
        ],
        { session },
      );

      return { order: mapCustomerOrder(order.toObject(), capability), created: true };
    });
  } catch (err) {
    if (err?.code === 11000 && /idempotencyKey/.test(String(err.message))) {
      const row = await EcommerceOrder.findOne({
        tenantId: req.auth.tenantId,
        customerId: req.auth.id,
        idempotencyKey,
      }).lean();
      if (row) {
        if (row.creationBodyHash && row.creationBodyHash !== bodyHash) {
          throw errors.conflict(
            "IDEMPOTENCY_KEY_REUSED",
            "This idempotency key was already used with a different request.",
          );
        }
        return { order: mapCustomerOrder(row, baseCapability), created: false };
      }
    }
    throw err;
  }
}

export async function cancelCustomerOrder(req) {
  const { directCancelCustomerOrder } = await import("./ecommerce-order-cancellation.service.js");
  await directCancelCustomerOrder(req);
  return getCustomerOrder(req);
}

async function refundRowsByOrderId(tenantId, orderIds) {
  if (!orderIds.length) return new Map();
  const refunds = await EcommercePaymentExceptionRefund.find({
    tenantId,
    orderId: { $in: orderIds },
  }).lean();
  const map = new Map();
  for (const row of refunds) map.set(row.orderId, row);
  return map;
}

export async function listCustomerOrders(req) {
  const { capability } = await loadCheckoutContext(req.auth.tenantId, req.tenant);
  const scope = {
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  };
  const sort = "createdAt:desc";
  const page = await paginate(EcommerceOrder, {
    scope,
    filters: {},
    cursor: req.query?.cursor,
    limit: req.query?.limit,
    sort,
  });
  const refundMap = await refundRowsByOrderId(
    req.auth.tenantId,
    page.data.map((r) => r._id),
  );
  return {
    items: page.data.map((r) => mapCustomerOrder(r, capability, refundMap.get(r._id))),
    meta: { ...page.meta, sort },
  };
}

export async function getCustomerOrder(req) {
  const { capability } = await loadCheckoutContext(req.auth.tenantId, req.tenant);
  const row = await EcommerceOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  if (!row) throw errors.notFound("Order");
  const refund = await EcommercePaymentExceptionRefund.findOne({
    tenantId: req.auth.tenantId,
    orderId: row._id,
  }).lean();
  const activeAttempt = await findActivePaymentAttempt(req.auth.tenantId, row._id);
  const mapped = mapCustomerOrder(
    row,
    capability,
    refund,
    mapCustomerActivePaymentAttempt(activeAttempt),
  );
  const { mapCancellationCapabilities } = await import("./ecommerce-order-cancellation.service.js");
  const { EcommerceOrderCancellationRequest } = await import("../models/index.js");
  const cancellationRequest = row.activeCancellationRequestId
    ? await EcommerceOrderCancellationRequest.findById(row.activeCancellationRequestId).lean()
    : null;
  const { mapCancellationRequest } = await import("./ecommerce-order-cancellation.service.js");
  return {
    ...mapped,
    cancellation: {
      capabilities: mapCancellationCapabilities(row, activeAttempt),
      request: mapCancellationRequest(cancellationRequest),
    },
  };
}

export async function listAdminOrders(req) {
  const { capability } = await loadCheckoutContext(req.auth.tenantId, req.tenant);
  return listAdminOrdersPaginated(req, async (row) => {
    const refundMap = await refundRowsByOrderId(req.auth.tenantId, [row._id]);
    return mapAdminOrder(row, capability, refundMap.get(row._id));
  });
}

export async function getAdminOrder(req) {
  const { capability } = await loadCheckoutContext(req.auth.tenantId, req.tenant);
  const row = await EcommerceOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!row) throw errors.notFound("Order");
  const refund = await EcommercePaymentExceptionRefund.findOne({
    tenantId: req.auth.tenantId,
    orderId: row._id,
  }).lean();
  const mapped = mapAdminOrder(row, capability, refund);
  const [withCustomer, returnSummary] = await Promise.all([
    attachAdminOrderCustomerDisplay(req.auth.tenantId, [mapped]),
    attachReturnSummaryToAdminOrder(req.auth.tenantId, row._id),
  ]);
  const base = { ...withCustomer[0], returnSummary };
  return attachAdminOrderCourierPresentation(base, row);
}

export async function listAdminOrderEvents(req) {
  const rows = await EcommerceOrderEvent.find({
    tenantId: req.auth.tenantId,
    orderId: req.params.orderId,
  })
    .sort({ at: -1 })
    .limit(Math.min(Number(req.query.limit) || 100, 200))
    .lean();
  return {
    items: rows.map((row) => ({
      id: row._id,
      type: row.type,
      actorType: row.actorType ?? null,
      actorId: row.actorId ?? null,
      payload: row.payload ?? {},
      at: row.at ?? row.createdAt ?? null,
    })),
  };
}
