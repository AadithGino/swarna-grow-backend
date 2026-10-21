import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { phonePeProvider, resolvePhonePeCredentials } from "../integrations/phonepe.provider.js";
import {
  isDigitalMetalBuyPaymentMerchantOrderId,
  isDigitalMetalPaymentExceptionRefundMerchantId,
} from "../lib/digital-metals-payment-reference.js";
import {
  DigitalMetalBuyOrder,
  DigitalMetalBuyPaymentAttempt,
  DigitalMetalPaymentExceptionRefund,
  Tenant,
} from "../models/index.js";
import { ensureCustomerRiskHoldForPaymentException } from "./digital-metals-risk-hold.service.js";
import { applyAdminCustomerScopeFilter } from "../lib/digital-metals-admin-scope.js";

const TERMINAL_REFUND = new Set(["SUCCEEDED", "MANUAL_RECORDED"]);
const REFUND_EXCEPTIONS = new Set([
  "LATE_SUCCESS",
  "LATE_SUCCESS_REFUND_REQUIRED",
  "DUPLICATE_PAYMENT_REFUND_REQUIRED",
  "DUPLICATE_PAYMENT",
  "CHARGEBACK",
]);

export async function ensureDigitalMetalPaymentExceptionRefundCase(
  session,
  { tenantId, order, paymentAttemptId, merchantOrderId, amountPaise, exceptionType },
) {
  const refundId = createId("dmref");
  const updated = await DigitalMetalPaymentExceptionRefund.findOneAndUpdate(
    { tenantId, orderId: order._id },
    {
      $setOnInsert: {
        _id: refundId,
        tenantId,
        orderId: order._id,
        paymentAttemptId,
        merchantOrderId,
        amountPaise,
        exceptionType: exceptionType === "DUPLICATE_PAYMENT" ? "DUPLICATE_PAYMENT" : exceptionType,
        status: "ASSIGNED",
      },
    },
    { session, upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const customerId = order.customerId;
  if (customerId && REFUND_EXCEPTIONS.has(exceptionType)) {
    await ensureCustomerRiskHoldForPaymentException(session, {
      tenantId,
      customerId,
      exceptionType,
      exposurePaise: amountPaise,
      relatedBuyOrderId: order._id,
      relatedRefundCaseId: updated?._id ?? refundId,
      buyOrderStatus: order.status,
    });
  }
}

export async function listAdminDigitalMetalPaymentExceptions(req) {
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  const filter = { tenantId: req.auth.tenantId };
  if (req.query.status) filter.status = req.query.status;
  const refunds = await DigitalMetalPaymentExceptionRefund.find(filter)
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();
  const orderIds = refunds.map((r) => r.orderId);
  const orderFilter = {
    tenantId: req.auth.tenantId,
    $or: [{ _id: { $in: orderIds } }, { paymentExceptionStatus: { $ne: null } }],
  };
  await applyAdminCustomerScopeFilter(req, orderFilter, { customerIdQuery: req.query.customerId });
  const orders = await DigitalMetalBuyOrder.find(orderFilter)
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();
  const allowedOrderIds = new Set(orders.map((o) => o._id));
  const scopedRefunds = refunds.filter((r) => allowedOrderIds.has(r.orderId));
  const byId = new Map(orders.map((o) => [o._id, o]));
  const items = scopedRefunds.map((refund) => ({
    refund,
    order: byId.get(refund.orderId) ?? null,
  }));
  const orphanOrders = orders.filter(
    (o) => o.paymentExceptionStatus && !refunds.some((r) => r.orderId === o._id),
  );
  for (const o of orphanOrders) {
    items.push({ refund: null, order: o });
  }
  return { items: items.slice(0, limit) };
}

export async function getAdminDigitalMetalBuyOrderRefund(req) {
  const order = await DigitalMetalBuyOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!order) throw errors.notFound("Order");
  const refund = await DigitalMetalPaymentExceptionRefund.findOne({
    tenantId: req.auth.tenantId,
    orderId: order._id,
  }).lean();
  return { orderId: order._id, refund: refund ?? null, order };
}

export async function initiateAdminDigitalMetalBuyOrderRefund(req) {
  const order = await DigitalMetalBuyOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!order) throw errors.notFound("Order");
  const refundRow = await DigitalMetalPaymentExceptionRefund.findOne({
    tenantId: req.auth.tenantId,
    orderId: order._id,
  }).lean();
  if (!refundRow) throw errors.notFound("Payment exception refund");
  if (
    !REFUND_EXCEPTIONS.has(order.paymentExceptionStatus)
    && !REFUND_EXCEPTIONS.has(refundRow.exceptionType)
  ) {
    throw errors.business("REFUND_NOT_APPLICABLE", "No refundable payment exception on this order.");
  }
  if (TERMINAL_REFUND.has(refundRow.status)) {
    return { refund: refundRow, initiated: false };
  }
  if (refundRow.status === "PROVIDER_PENDING" || refundRow.status === "INITIATED") {
    return { refund: refundRow, initiated: false, inFlight: true };
  }

  const merchantRefundId = refundRow._id;
  let claimed;
  try {
    claimed = await withTransaction(async (session) => {
      const updated = await DigitalMetalPaymentExceptionRefund.findOneAndUpdate(
        {
          _id: refundRow._id,
          tenantId: req.auth.tenantId,
          status: { $in: ["ASSIGNED", "FAILED"] },
        },
        {
          $set: {
            status: "INITIATED",
            assignedUserId: req.auth.id,
            providerRefundId: merchantRefundId,
          },
          $inc: { version: 1 },
        },
        { session, new: true },
      );
      if (!updated) {
        const current = await DigitalMetalPaymentExceptionRefund.findById(refundRow._id)
          .session(session)
          .lean();
        if (current && TERMINAL_REFUND.has(current.status)) return { kind: "DONE", refund: current };
        if (current?.status === "PROVIDER_PENDING" || current?.status === "INITIATED") {
          return { kind: "IN_FLIGHT", refund: current };
        }
        throw errors.conflict("REFUND_STATE_RACE", "Refund case changed elsewhere.");
      }
      return { kind: "CALL_PROVIDER", refund: updated.toObject() };
    });
  } catch (err) {
    if (err?.code === 11000) {
      const current = await DigitalMetalPaymentExceptionRefund.findById(refundRow._id).lean();
      if (current) return { refund: current, initiated: false, inFlight: true };
    }
    throw err;
  }

  if (claimed.kind === "DONE") return { refund: claimed.refund, initiated: false };
  if (claimed.kind === "IN_FLIGHT") {
    return { refund: claimed.refund, initiated: false, inFlight: true };
  }

  const tenant = await Tenant.findById(req.auth.tenantId).select("+integrationSecrets").lean();
  const credentials = resolvePhonePeCredentials(tenant);
  try {
    const provider = await phonePeProvider.initiateRefund({
      merchantRefundId,
      originalMerchantOrderId: claimed.refund.merchantOrderId,
      amountPaise: claimed.refund.amountPaise,
      credentials,
      tenantId: req.auth.tenantId,
    });
    const updated = await DigitalMetalPaymentExceptionRefund.findOneAndUpdate(
      {
        _id: refundRow._id,
        tenantId: req.auth.tenantId,
        status: "INITIATED",
      },
      {
        $set: {
          status: "PROVIDER_PENDING",
          providerRefundId: provider.refundId ?? merchantRefundId,
          providerPayload: provider,
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    return { refund: updated ?? claimed.refund, initiated: true };
  } catch (err) {
    await DigitalMetalPaymentExceptionRefund.updateOne(
      { _id: refundRow._id, status: "INITIATED" },
      { $set: { status: "FAILED", providerPayload: { error: err?.message } }, $inc: { version: 1 } },
    );
    throw new AppError("REFUND_INITIATION_FAILED", err?.message ?? "Refund initiation failed.", 502);
  }
}

export async function confirmDigitalMetalPaymentExceptionRefundFromProvider({
  tenantId,
  payload,
}) {
  const providerRefundId = payload.refundId ?? payload.merchantRefundId ?? null;
  let refundCase = null;
  if (providerRefundId && isDigitalMetalPaymentExceptionRefundMerchantId(providerRefundId)) {
    refundCase = await DigitalMetalPaymentExceptionRefund.findOne({
      _id: providerRefundId,
      tenantId,
    }).lean();
  }
  if (!refundCase && providerRefundId) {
    refundCase = await DigitalMetalPaymentExceptionRefund.findOne({
      tenantId,
      providerRefundId: String(providerRefundId),
    }).lean();
  }
  const original =
    payload.originalMerchantOrderId ?? payload.merchantOrderId ?? null;
  if (!refundCase && original && isDigitalMetalBuyPaymentMerchantOrderId(original)) {
    const attempt = await DigitalMetalBuyPaymentAttempt.findOne({
      tenantId,
      $or: [{ merchantOrderId: original }, { _id: original }],
    }).lean();
    if (attempt) {
      refundCase = await DigitalMetalPaymentExceptionRefund.findOne({
        tenantId,
        orderId: attempt.orderId,
      }).lean();
    }
  }
  if (!refundCase) return { outcome: "NOT_FOUND" };

  const state = String(payload.state ?? payload.status ?? "").toUpperCase();
  const failed = state.includes("FAIL");
  const succeeded = state.includes("COMPLET") || state.includes("SUCCESS");

  if (TERMINAL_REFUND.has(refundCase.status)) {
    return { outcome: "ALREADY_TERMINAL", refundId: refundCase._id };
  }

  if (succeeded) {
    await DigitalMetalPaymentExceptionRefund.updateOne(
      { _id: refundCase._id, status: { $nin: ["SUCCEEDED", "MANUAL_RECORDED"] } },
      {
        $set: { status: "SUCCEEDED", providerPayload: payload },
        $inc: { version: 1 },
      },
    );
    await DigitalMetalBuyOrder.updateOne(
      { _id: refundCase.orderId, tenantId, status: { $ne: "REFUNDED" } },
      { $set: { status: "REFUNDED" }, $inc: { version: 1 } },
    );
    return { outcome: "SUCCEEDED", refundId: refundCase._id };
  }
  if (failed) {
    await DigitalMetalPaymentExceptionRefund.updateOne(
      { _id: refundCase._id, status: { $nin: ["SUCCEEDED", "MANUAL_RECORDED"] } },
      { $set: { status: "FAILED", providerPayload: payload }, $inc: { version: 1 } },
    );
    return { outcome: "FAILED", refundId: refundCase._id };
  }
  return { outcome: "UNKNOWN", refundId: refundCase._id };
}
