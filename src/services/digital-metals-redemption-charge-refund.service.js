import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { isDigitalMetalRedemptionChargeRefundMerchantId } from "../lib/digital-metals-payment-reference.js";
import { phonePeProvider, resolvePhonePeCredentials } from "../integrations/phonepe.provider.js";
import {
  Customer,
  DigitalMetalRedemptionChargeRefundCase,
  DigitalMetalRedemptionOrder,
  Tenant,
} from "../models/index.js";
import { assertTenantOwnsCustomerScope } from "./digital-metals.service.js";
import { applyAdminCustomerScopeFilter } from "../lib/digital-metals-admin-scope.js";

const TERMINAL = new Set(["SUCCEEDED", "MANUAL_RECORDED"]);

export async function ensureRedemptionChargeRefundCase(
  session,
  { tenantId, order, paymentAttemptId, merchantOrderId, amountPaise, exceptionType },
) {
  const updated = await DigitalMetalRedemptionChargeRefundCase.findOneAndUpdate(
    { tenantId, redemptionOrderId: order._id, paymentAttemptId },
    {
      $setOnInsert: {
        _id: createId("dmrref"),
        tenantId,
        redemptionOrderId: order._id,
        customerId: order.customerId,
        paymentAttemptId,
        merchantOrderId,
        amountPaise,
        exceptionType,
        status: "ASSIGNED",
      },
    },
    { session, upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return updated;
}

export async function listAdminRedemptionChargeRefunds(req) {
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  const filter = { tenantId: req.auth.tenantId };
  if (req.query.status) filter.status = req.query.status;
  await applyAdminCustomerScopeFilter(req, filter, { customerIdQuery: req.query.customerId });
  const items = await DigitalMetalRedemptionChargeRefundCase.find(filter)
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();
  return { items };
}

export async function getAdminRedemptionOrderChargeRefund(req) {
  const order = await DigitalMetalRedemptionOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!order) throw errors.notFound("Redemption order");
  const cust = await Customer.findOne({ _id: order.customerId, tenantId: req.auth.tenantId }).lean();
  assertTenantOwnsCustomerScope(req, cust);
  const refund = await DigitalMetalRedemptionChargeRefundCase.findOne({
    tenantId: req.auth.tenantId,
    redemptionOrderId: order._id,
  })
    .sort({ createdAt: -1 })
    .lean();
  return { orderId: order._id, refund: refund ?? null, order };
}

export async function initiateAdminRedemptionChargeRefund(req) {
  const order = await DigitalMetalRedemptionOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!order) throw errors.notFound("Redemption order");
  const refundRow = await DigitalMetalRedemptionChargeRefundCase.findOne({
    tenantId: req.auth.tenantId,
    redemptionOrderId: order._id,
    status: { $nin: [...TERMINAL] },
  }).lean();
  if (!refundRow) throw errors.notFound("Charge refund case");
  if (TERMINAL.has(refundRow.status)) return { refund: refundRow, initiated: false };

  const merchantRefundId = refundRow._id;
  const tenant = await Tenant.findById(req.auth.tenantId).select("+integrationSecrets").lean();
  const credentials = resolvePhonePeCredentials(tenant);
  await DigitalMetalRedemptionChargeRefundCase.updateOne(
    { _id: refundRow._id, status: "ASSIGNED" },
    { $set: { status: "REFUND_INITIATED" }, $inc: { version: 1 } },
  );
  try {
    const provider = await phonePeProvider.initiateRefund({
      merchantRefundId,
      originalMerchantOrderId: refundRow.merchantOrderId,
      amountPaise: refundRow.amountPaise,
      credentials,
      tenantId: req.auth.tenantId,
    });
    const updated = await DigitalMetalRedemptionChargeRefundCase.findOneAndUpdate(
      { _id: refundRow._id },
      {
        $set: {
          status: "REFUND_INITIATED",
          providerRefundId: provider.refundId ?? merchantRefundId,
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    return { refund: updated, initiated: true };
  } catch (err) {
    await DigitalMetalRedemptionChargeRefundCase.updateOne(
      { _id: refundRow._id },
      { $set: { status: "FAILED" }, $inc: { version: 1 } },
    );
    throw new AppError("REFUND_INITIATION_FAILED", err?.message ?? "Refund failed.", 502);
  }
}

export async function recordManualRedemptionChargeRefund(req) {
  const { resolutionNote, evidenceUploadIds } = req.body;
  const evidence = (evidenceUploadIds ?? []).slice(0, 10);
  if (!resolutionNote?.trim() || evidence.length === 0) {
    throw errors.validation([
      { field: "resolutionNote", message: "Resolution note is required." },
      { field: "evidenceUploadIds", message: "At least one evidence upload is required." },
    ]);
  }
  const refundRow = await DigitalMetalRedemptionChargeRefundCase.findOne({
    _id: req.params.refundCaseId,
    tenantId: req.auth.tenantId,
  });
  if (!refundRow) throw errors.notFound("Refund case");
  if (TERMINAL.has(refundRow.status)) return { refund: refundRow.toObject() };
  if (refundRow.status === "REFUND_INITIATED") {
    throw new AppError(
      "GATEWAY_REFUND_IN_FLIGHT",
      "Gateway refund is in flight; wait for provider outcome before manual recording.",
      409,
    );
  }
  const updated = await DigitalMetalRedemptionChargeRefundCase.findOneAndUpdate(
    {
      _id: refundRow._id,
      tenantId: req.auth.tenantId,
      status: { $in: ["ASSIGNED", "FAILED"] },
    },
    {
      $set: {
        status: "MANUAL_RECORDED",
        resolutionNote: String(resolutionNote).slice(0, 2000),
        evidenceUploadIds: evidence,
        resolvedByUserId: req.auth.id,
        resolvedAt: new Date(),
      },
      $inc: { version: 1 },
    },
    { new: true },
  );
  if (!updated) {
    const fresh = await DigitalMetalRedemptionChargeRefundCase.findById(refundRow._id).lean();
    if (fresh?.status === "REFUND_INITIATED") {
      throw new AppError("GATEWAY_REFUND_IN_FLIGHT", "Gateway refund is in flight.", 409);
    }
    if (fresh?.status === "SUCCEEDED") {
      return { refund: fresh, note: "Provider refund already succeeded." };
    }
    throw errors.conflict("REFUND_STATE", "Refund case changed; refresh and retry.");
  }
  await DigitalMetalRedemptionOrder.updateOne(
    {
      _id: updated.redemptionOrderId,
      tenantId: req.auth.tenantId,
      status: { $in: ["REFUND_REVIEW", "CHARGE_PAID"] },
      paymentExceptionStatus: { $in: ["LATE_SUCCESS", "ADDITIONAL_CAPTURE", null] },
    },
    {
      $set: { status: "CANCELLED", paymentExceptionStatus: "REFUNDED" },
      $inc: { version: 1 },
    },
  );
  return { refund: updated.toObject() };
}

export async function confirmRedemptionChargeRefundFromProvider({ tenantId, payload }) {
  const providerRefundId = payload.refundId ?? payload.merchantRefundId ?? null;
  if (!providerRefundId || !isDigitalMetalRedemptionChargeRefundMerchantId(providerRefundId)) {
    return { outcome: "IGNORED" };
  }
  const refundCase = await DigitalMetalRedemptionChargeRefundCase.findOne({
    _id: providerRefundId,
    tenantId,
  });
  if (!refundCase) return { outcome: "NOT_FOUND" };
  if (TERMINAL.has(refundCase.status)) return { outcome: "ALREADY_TERMINAL" };
  const state = String(payload.state ?? payload.code ?? "").toUpperCase();
  if (state.includes("COMPLETED") || state.includes("SUCCESS")) {
    refundCase.status = "SUCCEEDED";
    await refundCase.save();
    await DigitalMetalRedemptionOrder.updateOne(
      { _id: refundCase.redemptionOrderId, tenantId, status: "REFUND_REVIEW" },
      { $set: { status: "CANCELLED", paymentExceptionStatus: "REFUNDED" }, $inc: { version: 1 } },
    );
    return { outcome: "SUCCEEDED" };
  }
  return { outcome: "PENDING" };
}
