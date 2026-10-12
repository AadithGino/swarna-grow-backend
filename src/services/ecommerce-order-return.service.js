import { createId } from "../lib/ids.js";
import { errors } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { hashIdempotencyBody } from "./idempotency.service.js";
import { mapPublishedStorePolicies } from "../lib/ecommerce-store-policies.js";
import { applyReturnReceiptRestockOnce } from "../lib/ecommerce-order-stock-restock.js";
import {
  EcommerceOrderRefundSource,
  EcommerceOrderReturnInspectionOutcome,
  EcommerceOrderReturnKind,
  EcommerceOrderReturnRequestStatus,
  EcommerceOrderStatus,
  EcommercePaymentExceptionRefundStatus,
  EcommercePaymentMethod,
} from "../constants/enums.js";
import {
  EcommerceFulfilmentSettings,
  EcommerceOrder,
  EcommerceOrderReturnRequest,
  EcommercePaymentAttempt,
  EcommercePaymentExceptionRefund,
} from "../models/index.js";

function pushHistory(row, entry) {
  if (!row.statusHistory) row.statusHistory = [];
  row.statusHistory.push(entry);
}

function mapReturn(row) {
  if (!row) return null;
  return {
    id: row._id,
    orderId: row.orderId,
    kind: row.kind,
    status: row.status,
    reason: row.reason,
    evidenceNote: row.evidenceNote ?? null,
    decisionReason: row.decisionReason ?? null,
    inspectionNote: row.inspectionNote ?? null,
    inspectionOutcome: row.inspectionOutcome ?? null,
    onlineRefundId: row.onlineRefundId ?? null,
    manualRefundRecordedAt: row.manualRefundRecordedAt ?? null,
    resolutionNote: row.resolutionNote ?? null,
    manualSettlementNote: row.manualSettlementNote ?? null,
    replacementOrderId: row.replacementOrderId ?? null,
    stockRestockedAt: row.stockRestockedAt ?? null,
    policySnapshotVersion: row.policySnapshotVersion ?? null,
    statusHistory: row.statusHistory ?? [],
    version: row.version ?? 1,
    createdAt: row.createdAt ?? null,
  };
}

function returnEligible(order, settingsRow) {
  if (order.status !== EcommerceOrderStatus.DELIVERED) {
    return { allowed: false, code: "ORDER_NOT_DELIVERED" };
  }
  const policies = mapPublishedStorePolicies(settingsRow);
  const days = policies.returnEligibilityDays ?? 0;
  if (days <= 0) {
    return { allowed: false, code: "RETURNS_NOT_CONFIGURED" };
  }
  const deliveredAt = order.deliveryTracking?.deliveredAt ?? order.updatedAt ?? order.createdAt;
  if (!deliveredAt) return { allowed: false, code: "DELIVERY_DATE_UNKNOWN" };
  const elapsed = Date.now() - new Date(deliveredAt).getTime();
  if (elapsed > days * 86_400_000) {
    return { allowed: false, code: "RETURN_WINDOW_EXPIRED" };
  }
  const excluded = new Set(policies.returnExcludedCategoryIds ?? []);
  for (const line of order.lines ?? []) {
    const categoryId = line.pricingSnapshot?.categoryId ?? line.categoryId;
    if (categoryId && excluded.has(categoryId)) {
      return { allowed: false, code: "PRODUCT_CATEGORY_EXCLUDED" };
    }
  }
  return { allowed: true, policyVersion: policies.version };
}

async function loadReturnForAdmin(req, session) {
  const row = await EcommerceOrderReturnRequest.findOne({
    _id: req.params.returnRequestId,
    tenantId: req.auth.tenantId,
  }).session(session);
  if (!row) throw errors.notFound("Return request");
  return row;
}

function assertExpectedVersion(row, expectedVersion) {
  if (Number(row.version ?? 0) !== expectedVersion) {
    throw errors.conflict("VERSION_CONFLICT", "Return request changed elsewhere.");
  }
}

async function validateReplacementOrderLink({
  tenantId,
  customerId,
  replacementOrderId,
  returnRequestId,
  session,
}) {
  const rep = await EcommerceOrder.findOne({ _id: replacementOrderId, tenantId }).session(session).lean();
  if (!rep) throw errors.notFound("Replacement order");
  if (rep.customerId !== customerId) {
    throw errors.business(
      "REPLACEMENT_CUSTOMER_MISMATCH",
      "Replacement order must belong to the same customer as the original order.",
    );
  }
  const linked = await EcommerceOrderReturnRequest.findOne({
    tenantId,
    replacementOrderId,
    _id: { $ne: returnRequestId },
  })
    .session(session)
    .lean();
  if (linked) {
    throw errors.business(
      "REPLACEMENT_ORDER_ALREADY_LINKED",
      "This order is already linked to another return or exchange request.",
    );
  }
}

async function createOnlineReturnRefundCase({ tenantId, order, returnRequestId, session }) {
  const attemptId = order.successfulPaymentAttemptId;
  if (!attemptId) {
    throw errors.business("REFUND_NOT_APPLICABLE", "No successful online payment on this order.");
  }
  const attempt = await EcommercePaymentAttempt.findOne({ _id: attemptId, tenantId }).session(session).lean();
  if (!attempt) throw errors.notFound("Payment attempt");
  const refundId = createId("epayref");
  try {
    const row = await EcommercePaymentExceptionRefund.findOneAndUpdate(
      { tenantId, orderId: order._id },
      {
        $setOnInsert: {
          _id: refundId,
          tenantId,
          orderId: order._id,
          paymentAttemptId: attempt._id,
          amountPaise: order.totalPaise,
          currency: attempt.currency ?? "INR",
          providerPaymentId: attempt.providerPaymentId,
          merchantOrderId: attempt.merchantOrderId ?? attempt._id,
          status: EcommercePaymentExceptionRefundStatus.ASSIGNED,
          refundSource: EcommerceOrderRefundSource.ORDER_RETURN,
          returnRequestId,
        },
      },
      { session, upsert: true, new: true },
    );
    return row;
  } catch (err) {
    if (err?.code === 11000) {
      throw errors.conflict("REFUND_CASE_EXISTS", "A refund case already exists for this order.");
    }
    throw err;
  }
}

export async function createCustomerReturnRequest(req) {
  const reason = String(req.body?.reason ?? "").trim();
  if (reason.length < 8) {
    throw errors.validation([{ field: "reason", message: "Provide a reason (at least 8 characters)." }]);
  }
  const kind = String(req.body?.kind ?? EcommerceOrderReturnKind.RETURN).trim();
  if (!Object.values(EcommerceOrderReturnKind).includes(kind)) {
    throw errors.validation([{ field: "kind", message: "Invalid return kind." }]);
  }
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  const bodyHash = hashIdempotencyBody(req.body ?? {});

  return withTransaction(async (session) => {
    const order = await EcommerceOrder.findOne({
      _id: req.params.orderId,
      tenantId: req.auth.tenantId,
      customerId: req.auth.id,
    }).session(session);
    if (!order) throw errors.notFound("Order");
    const settings = await EcommerceFulfilmentSettings.findOne({ tenantId: req.auth.tenantId })
      .session(session)
      .lean();
    const cap = returnEligible(order.toObject(), settings);
    if (!cap.allowed) {
      throw errors.business("RETURN_REQUEST_NOT_ALLOWED", "Return request is not allowed for this order.", {
        code: cap.code,
      });
    }
    if (idempotencyKey) {
      const dup = await EcommerceOrderReturnRequest.findOne({
        tenantId: req.auth.tenantId,
        orderId: order._id,
        idempotencyKey,
      })
        .session(session)
        .lean();
      if (dup) {
        if (dup.creationBodyHash && dup.creationBodyHash !== bodyHash) {
          throw errors.conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency key reused with different body.");
        }
        return { request: mapReturn(dup), created: false };
      }
    }
    const now = new Date();
    const row = (
      await EcommerceOrderReturnRequest.create(
        [
          {
            _id: createId("eret"),
            tenantId: req.auth.tenantId,
            orderId: order._id,
            customerId: req.auth.id,
            kind,
            status: EcommerceOrderReturnRequestStatus.PENDING_REVIEW,
            reason,
            evidenceNote: String(req.body?.evidenceNote ?? "").trim().slice(0, 1000) || undefined,
            policySnapshotVersion: cap.policyVersion,
            idempotencyKey: idempotencyKey || undefined,
            creationBodyHash: idempotencyKey ? bodyHash : undefined,
            statusHistory: [
              {
                status: EcommerceOrderReturnRequestStatus.PENDING_REVIEW,
                at: now,
                actorType: "CUSTOMER",
                actorId: req.auth.id,
              },
            ],
          },
        ],
        { session },
      )
    )[0];
    return { request: mapReturn(row.toObject()), created: true };
  });
}

export async function listAdminReturnRequests(req) {
  const rows = await EcommerceOrderReturnRequest.find({ tenantId: req.auth.tenantId })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  return { items: rows.map(mapReturn) };
}

export async function decideAdminReturnRequest(req) {
  const decision = String(req.body.decision ?? "").trim();
  const expectedVersion = Number(req.body.expectedVersion);
  if (!["APPROVE", "REJECT"].includes(decision)) {
    throw errors.validation([{ field: "decision", message: "decision must be APPROVE or REJECT." }]);
  }
  return withTransaction(async (session) => {
    const row = await loadReturnForAdmin(req, session);
    if (row.status !== EcommerceOrderReturnRequestStatus.PENDING_REVIEW) {
      throw errors.business("RETURN_NOT_PENDING", "Return request is not pending review.");
    }
    assertExpectedVersion(row, expectedVersion);
    const next =
      decision === "APPROVE"
        ? EcommerceOrderReturnRequestStatus.APPROVED
        : EcommerceOrderReturnRequestStatus.REJECTED;
    row.status = next;
    row.decisionReason = String(req.body.decisionReason ?? "").trim().slice(0, 2000) || undefined;
    pushHistory(row, {
      status: next,
      at: new Date(),
      actorType: "STAFF",
      actorId: req.auth.id,
      note: row.decisionReason,
    });
    row.version += 1;
    await row.save({ session });
    return { request: mapReturn(row.toObject()) };
  });
}

export async function recordAdminReturnReceived(req) {
  const expectedVersion = Number(req.body.expectedVersion);
  return withTransaction(async (session) => {
    const row = await loadReturnForAdmin(req, session);
    if (row.status !== EcommerceOrderReturnRequestStatus.APPROVED) {
      throw errors.business("RETURN_NOT_APPROVED", "Approve the return before recording receipt.");
    }
    assertExpectedVersion(row, expectedVersion);
    row.status = EcommerceOrderReturnRequestStatus.RECEIVED;
    pushHistory(row, {
      status: EcommerceOrderReturnRequestStatus.RECEIVED,
      at: new Date(),
      actorType: "STAFF",
      actorId: req.auth.id,
      note: String(req.body.receiptNote ?? "").trim().slice(0, 2000) || undefined,
    });
    row.version += 1;
    await row.save({ session });
    return { request: mapReturn(row.toObject()) };
  });
}

export async function recordAdminReturnInspection(req) {
  const expectedVersion = Number(req.body.expectedVersion);
  const inspectionNote = String(req.body.inspectionNote ?? "").trim().slice(0, 2000);
  const outcome = String(req.body.inspectionOutcome ?? "").trim();
  const confirmRestock = req.body.confirmRestockInventory === true;
  if (inspectionNote.length < 4) {
    throw errors.validation([{ field: "inspectionNote", message: "Inspection note is required." }]);
  }
  if (!Object.values(EcommerceOrderReturnInspectionOutcome).includes(outcome)) {
    throw errors.validation([
      { field: "inspectionOutcome", message: "inspectionOutcome must be APPROVED_FOR_RESALE or REJECTED_NOT_RESALABLE." },
    ]);
  }
  if (outcome === EcommerceOrderReturnInspectionOutcome.APPROVED_FOR_RESALE && !confirmRestock) {
    throw errors.validation([
      {
        field: "confirmRestockInventory",
        message: "Set confirmRestockInventory to true to restock after approving the item for resale.",
      },
    ]);
  }
  return withTransaction(async (session) => {
    const row = await loadReturnForAdmin(req, session);
    if (row.status !== EcommerceOrderReturnRequestStatus.RECEIVED) {
      throw errors.business("RETURN_NOT_RECEIVED", "Record physical return receipt before inspection.");
    }
    assertExpectedVersion(row, expectedVersion);
    let restockResult = null;
    if (outcome === EcommerceOrderReturnInspectionOutcome.APPROVED_FOR_RESALE) {
      if (row.stockRestockedAt) {
        restockResult = { kind: "ALREADY_RESTOCKED" };
      } else {
        const at = new Date();
        const claimed = await EcommerceOrderReturnRequest.findOneAndUpdate(
          {
            _id: row._id,
            tenantId: req.auth.tenantId,
            stockRestockedAt: null,
            version: expectedVersion,
          },
          { $set: { stockRestockedAt: at } },
          { session, new: true },
        );
        if (!claimed) {
          const again = await EcommerceOrderReturnRequest.findOne({ _id: row._id, tenantId: req.auth.tenantId })
            .session(session)
            .lean();
          if (again?.stockRestockedAt) {
            restockResult = { kind: "ALREADY_RESTOCKED" };
          } else {
            throw errors.conflict("VERSION_CONFLICT", "Return request changed elsewhere.");
          }
        } else {
          try {
            restockResult = await applyReturnReceiptRestockOnce({
              tenantId: req.auth.tenantId,
              orderId: row.orderId,
              returnRequestId: row._id,
              actorUserId: req.auth.id,
              session,
              at,
            });
            row.stockRestockedAt = at;
          } catch (err) {
            await EcommerceOrderReturnRequest.updateOne(
              { _id: row._id, tenantId: req.auth.tenantId, stockRestockedAt: at },
              { $unset: { stockRestockedAt: "" } },
              { session },
            );
            throw err;
          }
        }
      }
    }
    row.status = EcommerceOrderReturnRequestStatus.INSPECTED;
    row.inspectionNote = inspectionNote;
    row.inspectionOutcome = outcome;
    pushHistory(row, {
      status: EcommerceOrderReturnRequestStatus.INSPECTED,
      at: new Date(),
      actorType: "STAFF",
      actorId: req.auth.id,
      note: inspectionNote,
    });
    row.version += 1;
    await row.save({ session });
    return { request: mapReturn(row.toObject()), restock: restockResult };
  });
}

export async function resolveAdminReturnRequest(req) {
  const expectedVersion = Number(req.body.expectedVersion);
  const resolutionNote = String(req.body.resolutionNote ?? "").trim().slice(0, 2000);
  if (resolutionNote.length < 8) {
    throw errors.validation([
      { field: "resolutionNote", message: "Describe the resolution (at least 8 characters)." },
    ]);
  }
  const replacementOrderId = String(req.body.replacementOrderId ?? "").trim() || undefined;
  const manualSettlementNote = String(req.body.manualSettlementNote ?? "").trim().slice(0, 2000) || undefined;
  return withTransaction(async (session) => {
    const row = await loadReturnForAdmin(req, session);
    if (row.status !== EcommerceOrderReturnRequestStatus.INSPECTED) {
      throw errors.business("RETURN_NOT_READY", "Complete inspection before resolving.");
    }
    if (row.kind === EcommerceOrderReturnKind.EXCHANGE && !replacementOrderId && !manualSettlementNote) {
      throw errors.validation([
        {
          field: "replacementOrderId",
          message: "Link a replacement order or record manual exchange settlement.",
        },
      ]);
    }
    assertExpectedVersion(row, expectedVersion);
    const order = await EcommerceOrder.findOne({ _id: row.orderId, tenantId: req.auth.tenantId })
      .session(session)
      .lean();
    if (!order) throw errors.notFound("Order");
    if (replacementOrderId) {
      await validateReplacementOrderLink({
        tenantId: req.auth.tenantId,
        customerId: order.customerId,
        replacementOrderId,
        returnRequestId: row._id,
        session,
      });
    }
    row.status = EcommerceOrderReturnRequestStatus.RESOLVED;
    row.resolutionNote = resolutionNote;
    row.replacementOrderId = replacementOrderId;
    row.manualSettlementNote = manualSettlementNote;
    pushHistory(row, {
      status: EcommerceOrderReturnRequestStatus.RESOLVED,
      at: new Date(),
      actorType: "STAFF",
      actorId: req.auth.id,
      note: resolutionNote,
    });
    row.version += 1;
    await row.save({ session });
    return { request: mapReturn(row.toObject()) };
  });
}

export async function createAdminReturnRefundCase(req) {
  const expectedVersion = Number(req.body.expectedVersion);
  return withTransaction(async (session) => {
    const row = await loadReturnForAdmin(req, session);
    if (row.onlineRefundId) {
      const existing = await EcommercePaymentExceptionRefund.findOne({
        _id: row.onlineRefundId,
        tenantId: req.auth.tenantId,
      })
        .session(session)
        .lean();
      return { request: mapReturn(row.toObject()), refund: existing, created: false };
    }
    assertExpectedVersion(row, expectedVersion);
    if (row.kind !== EcommerceOrderReturnKind.RETURN) {
      throw errors.business("REFUND_NOT_APPLICABLE", "Refund cases apply to return requests, not exchanges.");
    }
    if (row.status !== EcommerceOrderReturnRequestStatus.INSPECTED) {
      throw errors.business("RETURN_NOT_INSPECTED", "Complete inspection before opening a refund case.");
    }
    const order = await EcommerceOrder.findOne({ _id: row.orderId, tenantId: req.auth.tenantId })
      .session(session)
      .lean();
    if (!order) throw errors.notFound("Order");
    if (order.paymentMethod === EcommercePaymentMethod.COD) {
      throw errors.business("USE_MANUAL_RETURN_REFUND", "Use manual return refund recording for COD orders.");
    }
    const refundRow = await createOnlineReturnRefundCase({
      tenantId: req.auth.tenantId,
      order,
      returnRequestId: row._id,
      session,
    });
    row.onlineRefundId = refundRow._id;
    row.version += 1;
    await row.save({ session });
    return { request: mapReturn(row.toObject()), refund: refundRow.toObject(), created: true };
  });
}

export async function recordAdminReturnManualRefund(req) {
  const expectedVersion = Number(req.body.expectedVersion);
  const amountPaise = Number(req.body.amountPaise);
  const recipient = String(req.body.recipient ?? "").trim();
  const method = String(req.body.method ?? "").trim();
  const reference = String(req.body.reference ?? "").trim();
  const proofNote = String(req.body.proofNote ?? "").trim();
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw errors.validation([{ field: "amountPaise", message: "Valid amountPaise is required." }]);
  }
  for (const [field, val] of [
    ["recipient", recipient],
    ["method", method],
    ["reference", reference],
    ["proofNote", proofNote],
  ]) {
    if (val.length < 2) {
      throw errors.validation([{ field, message: `${field} is required.` }]);
    }
  }
  return withTransaction(async (session) => {
    const row = await loadReturnForAdmin(req, session);
    if (row.manualRefundRecordedAt) {
      return { request: mapReturn(row.toObject()), recorded: false };
    }
    assertExpectedVersion(row, expectedVersion);
    if (row.kind !== EcommerceOrderReturnKind.RETURN) {
      throw errors.business("REFUND_NOT_APPLICABLE", "Manual refunds apply to return requests.");
    }
    if (row.status !== EcommerceOrderReturnRequestStatus.INSPECTED) {
      throw errors.business("RETURN_NOT_INSPECTED", "Complete inspection before recording a refund.");
    }
    const order = await EcommerceOrder.findOne({ _id: row.orderId, tenantId: req.auth.tenantId })
      .session(session)
      .lean();
    if (!order) throw errors.notFound("Order");
    if (amountPaise !== Number(order.totalPaise)) {
      throw errors.validation([
        { field: "amountPaise", message: "Refund amount must match the order total for this return." },
      ]);
    }
    const updated = await EcommerceOrderReturnRequest.findOneAndUpdate(
      {
        _id: row._id,
        tenantId: req.auth.tenantId,
        manualRefundRecordedAt: null,
        version: expectedVersion,
      },
      {
        $set: {
          manualRefundRecordedAt: new Date(),
          manualRefundProof: {
            amountPaise,
            recipient,
            method,
            reference,
            proofNote,
            recordedByUserId: req.auth.id,
            idempotencyKey: idempotencyKey || undefined,
          },
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    );
    if (!updated) throw errors.conflict("REFUND_ALREADY_RECORDED", "Manual return refund already recorded.");
    return { request: mapReturn(updated.toObject()), recorded: true };
  });
}

export async function getCustomerOrderReturn(req) {
  const row = await EcommerceOrderReturnRequest.findOne({
    tenantId: req.auth.tenantId,
    orderId: req.params.orderId,
    customerId: req.auth.id,
  })
    .sort({ createdAt: -1 })
    .lean();
  return { request: mapReturn(row) };
}
