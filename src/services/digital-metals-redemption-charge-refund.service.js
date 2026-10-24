import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { classifyRefundInitiationError } from "../lib/gateway-refund-initiation-classifier.js";
import { isDigitalMetalRedemptionChargeRefundMerchantId } from "../lib/digital-metals-payment-reference.js";
import { withTransaction } from "../lib/transaction.js";
import { phonePeProvider, resolvePhonePeCredentials } from "../integrations/phonepe.provider.js";
import {
  Customer,
  DigitalMetalRedemptionChargeRefundCase,
  DigitalMetalRedemptionOrder,
  Tenant,
} from "../models/index.js";
import { assertTenantOwnsCustomerScope } from "./digital-metals.service.js";
import {
  applyAdminCustomerScopeFilter,
  assertAdminCustomerInScope,
} from "../lib/digital-metals-admin-scope.js";
import {
  paginateByIdCursor,
  parseAdminScopedListQuery,
} from "../lib/digital-metals-customer-order-access.js";
import { OPEN_REDEMPTION_CHARGE_REFUND_STATUSES } from "../lib/digital-metals-open-work-statuses.js";

const TERMINAL = new Set(["SUCCEEDED", "MANUAL_RECORDED"]);

async function resolveRedemptionOrderAfterChargeRefund(tenantId, refundCase) {
  if (refundCase.exceptionType === "ADDITIONAL_CAPTURE") {
    await DigitalMetalRedemptionOrder.updateOne(
      {
        _id: refundCase.redemptionOrderId,
        tenantId,
        paymentExceptionStatus: "ADDITIONAL_CAPTURE",
      },
      { $set: { paymentExceptionStatus: "REFUNDED" }, $inc: { version: 1 } },
    );
    return;
  }
  await DigitalMetalRedemptionOrder.updateOne(
    {
      _id: refundCase.redemptionOrderId,
      tenantId,
      status: { $in: ["REFUND_REVIEW", "CHARGE_PAID"] },
      paymentExceptionStatus: { $in: ["LATE_SUCCESS", "DUPLICATE_PAYMENT", null] },
    },
    {
      $set: { status: "CANCELLED", paymentExceptionStatus: "REFUNDED" },
      $inc: { version: 1 },
    },
  );
}

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
  const { limit, cursor } = parseAdminScopedListQuery(req);
  const filter = { tenantId: req.auth.tenantId };
  const statusRaw = req.query.status ? String(req.query.status).trim() : "";
  if (statusRaw && statusRaw.toUpperCase() !== "ALL") {
    filter.status = statusRaw.toUpperCase() === "OPEN" ? { $in: [...OPEN_REDEMPTION_CHARGE_REFUND_STATUSES] } : statusRaw;
  }
  await applyAdminCustomerScopeFilter(req, filter, { customerIdQuery: req.query.customerId });
  if (cursor) filter._id = { $lt: cursor };
  const rows = await DigitalMetalRedemptionChargeRefundCase.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean();
  const { items, meta } = paginateByIdCursor(rows, limit);
  return { items, meta };
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
  const cust = await Customer.findOne({ _id: order.customerId, tenantId: req.auth.tenantId }).lean();
  assertTenantOwnsCustomerScope(req, cust);

  const refundRow = await DigitalMetalRedemptionChargeRefundCase.findOne({
    tenantId: req.auth.tenantId,
    redemptionOrderId: order._id,
    status: { $nin: [...TERMINAL] },
  }).lean();
  if (!refundRow) throw errors.notFound("Charge refund case");
  if (TERMINAL.has(refundRow.status)) return { refund: refundRow, initiated: false };
  if (refundRow.status === "REFUND_INITIATED") {
    return { refund: refundRow, initiated: false, inFlight: true };
  }

  const merchantRefundId = refundRow._id;
  let claimed;
  try {
    claimed = await withTransaction(async (session) => {
      const updated = await DigitalMetalRedemptionChargeRefundCase.findOneAndUpdate(
        {
          _id: refundRow._id,
          tenantId: req.auth.tenantId,
          status: { $in: ["ASSIGNED", "FAILED"] },
        },
        {
          $set: {
            status: "REFUND_INITIATED",
            providerRefundId: merchantRefundId,
          },
          $inc: { version: 1 },
        },
        { session, new: true },
      );
      if (!updated) {
        const current = await DigitalMetalRedemptionChargeRefundCase.findById(refundRow._id)
          .session(session)
          .lean();
        if (current && TERMINAL.has(current.status)) return { kind: "DONE", refund: current };
        if (current?.status === "REFUND_INITIATED") {
          return { kind: "IN_FLIGHT", refund: current };
        }
        throw errors.conflict("REFUND_STATE_RACE", "Refund case changed elsewhere.");
      }
      return { kind: "CALL_PROVIDER", refund: updated.toObject() };
    });
  } catch (err) {
    if (err?.code === 11000) {
      const current = await DigitalMetalRedemptionChargeRefundCase.findById(refundRow._id).lean();
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
    const updated = await DigitalMetalRedemptionChargeRefundCase.findOneAndUpdate(
      {
        _id: refundRow._id,
        tenantId: req.auth.tenantId,
        status: "REFUND_INITIATED",
      },
      {
        $set: {
          providerRefundId: provider.refundId ?? merchantRefundId,
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    return { refund: updated ?? claimed.refund, initiated: true };
  } catch (err) {
    const failureClass = classifyRefundInitiationError(err);
    if (failureClass === "DEFINITIVE_REJECT") {
      await DigitalMetalRedemptionChargeRefundCase.updateOne(
        { _id: refundRow._id, status: "REFUND_INITIATED" },
        { $set: { status: "FAILED" }, $inc: { version: 1 } },
      );
    }
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
  await assertAdminCustomerInScope(req, refundRow.customerId);
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
  await resolveRedemptionOrderAfterChargeRefund(req.auth.tenantId, updated.toObject());
  return { refund: updated.toObject() };
}

export async function confirmRedemptionChargeRefundFromProvider({ tenantId, payload }) {
  const providerRefundId = payload.refundId ?? payload.merchantRefundId ?? null;
  if (!providerRefundId || !isDigitalMetalRedemptionChargeRefundMerchantId(providerRefundId)) {
    return { outcome: "IGNORED" };
  }
  const existing = await DigitalMetalRedemptionChargeRefundCase.findOne({
    _id: providerRefundId,
    tenantId,
  }).lean();
  if (!existing) return { outcome: "NOT_FOUND" };
  if (TERMINAL.has(existing.status)) return { outcome: "ALREADY_TERMINAL" };

  const state = String(payload.state ?? payload.code ?? "").toUpperCase();
  const failed = state.includes("FAIL");
  const succeeded = state.includes("COMPLET") || state.includes("SUCCESS");

  if (succeeded) {
    const updated = await DigitalMetalRedemptionChargeRefundCase.findOneAndUpdate(
      { _id: providerRefundId, tenantId, status: { $nin: [...TERMINAL] } },
      { $set: { status: "SUCCEEDED" }, $inc: { version: 1 } },
      { new: true },
    );
    if (!updated) return { outcome: "ALREADY_TERMINAL" };
    await resolveRedemptionOrderAfterChargeRefund(tenantId, updated.toObject());
    return { outcome: "SUCCEEDED" };
  }
  if (failed) {
    await DigitalMetalRedemptionChargeRefundCase.updateOne(
      { _id: providerRefundId, tenantId, status: { $nin: [...TERMINAL] } },
      { $set: { status: "FAILED" }, $inc: { version: 1 } },
    );
    return { outcome: "FAILED" };
  }
  return { outcome: "PENDING" };
}

/** Poll PhonePe for in-flight redemption charge refunds (recovery after ambiguous initiation). */
export async function reconcileRedemptionChargeRefundCase({ tenantId, refundCaseId }) {
  const refundCase = await DigitalMetalRedemptionChargeRefundCase.findOne({
    _id: refundCaseId,
    tenantId,
  }).lean();
  if (!refundCase) return { outcome: "NOT_FOUND" };
  if (TERMINAL.has(refundCase.status)) {
    return { outcome: "ALREADY_TERMINAL", status: refundCase.status };
  }
  if (refundCase.status !== "REFUND_INITIATED") {
    return { outcome: "NOT_RECONCILABLE", status: refundCase.status };
  }
  const tenant = await Tenant.findById(tenantId).select("+integrationSecrets").lean();
  const credentials = resolvePhonePeCredentials(tenant);
  const providerStatus = await phonePeProvider.getRefundStatus({
    merchantRefundId: refundCase._id,
    originalMerchantOrderId: refundCase.merchantOrderId,
    credentials,
    tenantId,
  });
  const state = String(providerStatus?.state ?? providerStatus?.status ?? "PENDING");
  return confirmRedemptionChargeRefundFromProvider({
    tenantId,
    payload: { merchantRefundId: refundCase._id, state },
  });
}
