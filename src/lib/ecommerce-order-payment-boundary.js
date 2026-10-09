import {
  EcommerceOrderStatus,
  EcommerceQuoteStatus,
  EcommerceStockPolicy,
} from "../constants/enums.js";
import { evaluateCheckoutTaxReadiness } from "./ecommerce-checkout-tax.js";
import { revalidateQuoteForOrder } from "./ecommerce-quote-revalidation.js";
import {
  EcommerceFulfilmentSettings,
  EcommerceOrder,
  EcommercePriceQuote,
  EcommerceStockReservation,
  EcommerceTaxSettings,
} from "../models/index.js";

/** Transaction-boundary checks before creating or resuming a payment attempt. */
export async function assertOrderPaymentBoundary({
  orderRow,
  tenant,
  customerId,
  session,
  at = new Date(),
}) {
  const order =
    orderRow?.status != null
      ? orderRow
      : await EcommerceOrder.findOne({ _id: orderRow, tenantId: tenant._id }).session(session);
  if (!order || order.customerId !== customerId) {
    return { ok: false, code: "ORDER_NOT_FOUND" };
  }
  if (order.paymentExceptionStatus) {
    return { ok: false, code: "PAYMENT_EXCEPTION", status: order.paymentExceptionStatus };
  }
  if (order.status !== EcommerceOrderStatus.PENDING_PAYMENT) {
    return { ok: false, code: "ORDER_NOT_PAYABLE", status: order.status };
  }
  if (order.expiresAt && new Date(order.expiresAt) <= at) {
    return { ok: false, code: "ORDER_PAYMENT_WINDOW_EXPIRED" };
  }
  if (!Number.isInteger(order.totalPaise) || order.totalPaise <= 0) {
    return { ok: false, code: "ORDER_AMOUNT_INVALID" };
  }
  if (String(order.currency ?? "INR") !== "INR") {
    return { ok: false, code: "ORDER_CURRENCY_UNSUPPORTED" };
  }

  const fulfilmentRow = await EcommerceFulfilmentSettings.findOne({ tenantId: order.tenantId })
    .session(session)
    .lean();
  const taxSettings = await EcommerceTaxSettings.findOne({ tenantId: order.tenantId })
    .session(session)
    .lean();
  const taxReadiness = evaluateCheckoutTaxReadiness(taxSettings, fulfilmentRow ?? {});
  if (!taxReadiness.ready) {
    return { ok: false, code: "CHECKOUT_TAX_NOT_READY", blockers: taxReadiness.blockers };
  }

  if (order.quoteId) {
    const quote = await EcommercePriceQuote.findOne({
      _id: order.quoteId,
      tenantId: order.tenantId,
    })
      .session(session)
      .lean();
    if (quote?.status === EcommerceQuoteStatus.ACTIVE) {
      const validation = await revalidateQuoteForOrder({
        quoteRow: quote,
        tenant,
        customerId,
        session,
        at,
      });
      if (!validation.ok) {
        return { ok: false, code: "QUOTE_REVALIDATION_FAILED", blockers: validation.blockers };
      }
    }
    const snapTotal = Number(order.financialSnapshot?.totalPaise ?? order.totalPaise);
    if (snapTotal !== order.totalPaise) {
      return { ok: false, code: "ORDER_AMOUNT_SNAPSHOT_MISMATCH" };
    }
  }

  const reservations = await EcommerceStockReservation.find({
    tenantId: order.tenantId,
    orderId: order._id,
    releasedAt: null,
  })
    .session(session)
    .lean();
  const reservedByProduct = new Map();
  for (const row of reservations) {
    const pid = String(row.productId ?? "");
    if (!pid) continue;
    reservedByProduct.set(pid, (reservedByProduct.get(pid) ?? 0) + Number(row.quantity ?? 0));
  }

  for (const line of order.lines ?? []) {
    const productId = String(line.productId ?? "");
    const lineQty = Number(line.quantity ?? 0);
    if (!productId || lineQty <= 0) continue;
    const policy =
      line.pricingSnapshot?.stockPolicy
      ?? line.availability?.stockPolicy
      ?? EcommerceStockPolicy.MADE_TO_ORDER;
    if (policy !== EcommerceStockPolicy.QUANTITY_TRACKED) continue;

    const reservedQty = reservedByProduct.get(productId) ?? 0;
    if (reservedQty === 0) {
      return { ok: false, code: "RESERVATION_MISSING", productId };
    }
    if (reservedQty !== lineQty) {
      return { ok: false, code: "RESERVATION_OWNERSHIP", productId };
    }
    reservedByProduct.delete(productId);
  }

  if (reservedByProduct.size > 0) {
    return { ok: false, code: "RESERVATION_OWNERSHIP" };
  }

  return { ok: true, order, amountPaise: order.totalPaise, currency: "INR" };
}
