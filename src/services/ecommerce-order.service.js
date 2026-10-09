import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { assertEcommerceOperational } from "../lib/ecommerce-access.js";
import { evaluateCheckoutTaxReadiness } from "../lib/ecommerce-checkout-tax.js";
import {
  assertCustomerOrderCreationAllowed,
  deriveEcommerceCheckoutCapability,
} from "../lib/ecommerce-checkout-capability.js";
import { cancelPendingPaymentOrderRow } from "../lib/ecommerce-order-lifecycle.js";
import { findActivePaymentAttempt } from "../lib/ecommerce-payment-in-flight.js";
import { mapCustomerActivePaymentAttempt } from "./ecommerce-payment-intent.service.js";
import { computePendingPaymentExpiresAt } from "../lib/ecommerce-pending-payment-policy.js";
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
  Tenant,
} from "../models/index.js";
import {
  EcommerceOrderEventType,
  EcommerceOrderStatus,
  EcommercePaymentExceptionRefundStatus,
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
  const cap = capability ?? {
    paymentAllowed: false,
    checkoutUsable: false,
    checkoutTaxReady: false,
  };
  return {
    id: row._id,
    orderNumber: row.orderNumber,
    status: row.status,
    statusLabel: pending
      ? "Awaiting payment — not charged"
      : row.status === EcommerceOrderStatus.PAYMENT_EXPIRED
        ? "Payment window expired — not charged"
        : String(row.status),
    paymentAllowed: cap.paymentAllowed,
    paymentCompleted: row.status === EcommerceOrderStatus.PAID,
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
    activePaymentAttempt,
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
  };
}

async function loadCheckoutContext(tenantId, tenant) {
  const tenantDoc =
    tenant?.integrationSecrets != null
      ? tenant
      : await Tenant.findById(tenantId).select("+integrationSecrets").lean();
  const fulfilmentRow = await EcommerceFulfilmentSettings.findOne({ tenantId }).lean();
  const taxSettings = await EcommerceTaxSettings.findOne({ tenantId }).lean();
  const capability = deriveEcommerceCheckoutCapability({
    taxSettings,
    fulfilmentSettingsRow: fulfilmentRow ?? {},
    tenant: tenantDoc ?? tenant,
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

export async function createCustomerOrder(req) {
  assertEcommerceOperational(req.tenant);
  const { fulfilmentRow, taxSettings, capability } = await loadCheckoutContext(
    req.auth.tenantId,
    req.tenant,
  );
  assertCustomerOrderCreationAllowed(capability);

  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
  }
  const bodyHash = hashIdempotencyBody(req.body);
  const quoteId = String(req.body.quoteId ?? "").trim();
  if (!quoteId) {
    throw errors.validation([{ field: "quoteId", message: "quoteId is required." }]);
  }

  const early = await loadExistingOrderByIdempotency(req, bodyHash, capability);
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
        return { order: mapCustomerOrder(dup.toObject(), capability), created: false };
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
          return { order: mapCustomerOrder(linked.toObject(), capability), created: false };
        }
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

      const paymentExpiresAt = computePendingPaymentExpiresAt(
        new Date(),
        fulfilmentRow?.toObject?.() ?? fulfilmentRow ?? {},
      );
      await transferQuoteReservationsToOrder({
        tenantId: req.auth.tenantId,
        quoteId: quote._id,
        orderId,
        session,
        expiresAt: paymentExpiresAt,
      });

      const orderNumber = `EC-${createId("ordn").slice(-10).toUpperCase()}`;
      const financialSnapshot = {
        ...(quote.financialSnapshot?.toObject?.() ?? quote.financialSnapshot ?? {}),
        quoteId: quote._id,
        quoteFinancialSnapshot: quote.financialSnapshot,
        quoteLines: quote.lines,
        consumedAt: new Date().toISOString(),
        paymentExpiresAt: paymentExpiresAt.toISOString(),
      };

      const order = (
        await EcommerceOrder.create(
          [
            {
              _id: orderId,
              tenantId: req.auth.tenantId,
              customerId: req.auth.id,
              orderNumber,
              status: EcommerceOrderStatus.PENDING_PAYMENT,
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
              idempotencyKey,
              creationBodyHash: bodyHash,
              expiresAt: paymentExpiresAt,
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
            type: EcommerceOrderEventType.ORDER_CREATED,
            actorType: "CUSTOMER",
            actorId: req.auth.id,
            payload: {
              quoteId: quote._id,
              paymentExpiresAt: paymentExpiresAt.toISOString(),
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
        return { order: mapCustomerOrder(row, capability), created: false };
      }
    }
    throw err;
  }
}

export async function cancelCustomerOrder(req) {
  assertEcommerceOperational(req.tenant);
  const { capability } = await loadCheckoutContext(req.auth.tenantId, req.tenant);
  return withTransaction(async (session) => {
    const result = await cancelPendingPaymentOrderRow({
      orderId: req.params.orderId,
      tenantId: req.auth.tenantId,
      customerId: req.auth.id,
      session,
    });
    if (result.kind === "NOT_FOUND") throw errors.notFound("Order");
    if (result.kind === "NOT_CANCELLABLE") {
      if (
        result.status === EcommerceOrderStatus.PAID
        || result.status === EcommerceOrderStatus.PROCESSING
      ) {
        throw errors.business("ORDER_NOT_CANCELLABLE", "Paid orders cannot be cancelled here.", {
          status: result.status,
        });
      }
      throw errors.business("ORDER_NOT_CANCELLABLE", "Order cannot be cancelled.", {
        status: result.status,
      });
    }
    if (result.kind === "RACE") {
      throw errors.business("ORDER_NOT_CANCELLABLE", "Order is no longer pending payment.");
    }
    await EcommerceOrderEvent.create(
      [
        {
          _id: createId("eoev"),
          tenantId: req.auth.tenantId,
          orderId: result.order._id,
          type: EcommerceOrderEventType.CANCELLED,
          actorType: "CUSTOMER",
          actorId: req.auth.id,
          payload: { stockReleaseReason: result.order.stockReleaseReason },
        },
      ],
      { session },
    );
    return mapCustomerOrder(result.order.toObject(), capability);
  });
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
  assertEcommerceOperational(req.tenant);
  const { capability } = await loadCheckoutContext(req.auth.tenantId, req.tenant);
  const rows = await EcommerceOrder.find({
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  })
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(req.query.limit) || 50, 100))
    .lean();
  const refundMap = await refundRowsByOrderId(
    req.auth.tenantId,
    rows.map((r) => r._id),
  );
  return {
    items: rows.map((r) => mapCustomerOrder(r, capability, refundMap.get(r._id))),
  };
}

export async function getCustomerOrder(req) {
  assertEcommerceOperational(req.tenant);
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
  return mapCustomerOrder(
    row,
    capability,
    refund,
    mapCustomerActivePaymentAttempt(activeAttempt),
  );
}

export async function listAdminOrders(req) {
  const { capability } = await loadCheckoutContext(req.auth.tenantId, req.tenant);
  const rows = await EcommerceOrder.find({ tenantId: req.auth.tenantId })
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(req.query.limit) || 50, 100))
    .lean();
  const refundMap = await refundRowsByOrderId(
    req.auth.tenantId,
    rows.map((r) => r._id),
  );
  return {
    items: rows.map((r) => mapAdminOrder(r, capability, refundMap.get(r._id))),
  };
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
  return mapAdminOrder(row, capability, refund);
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
