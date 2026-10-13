import { createId } from "../lib/ids.js";
import { errors } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { hashIdempotencyBody } from "./idempotency.service.js";
import {
  cancelCodPendingAcceptanceOrderRow,
  cancelPendingPaymentOrderRow,
} from "../lib/ecommerce-order-lifecycle.js";
import {
  adminCancellationEligible,
  cancellationNeedsCodManualRefund,
  cancellationNeedsOnlineRefund,
  customerCancellationRequestEligible,
  customerDirectCancelEligible,
  isShippedOrDelivered,
  paymentAttemptBlocksCustomerCancel,
} from "../lib/ecommerce-order-cancellation-policy.js";
import { orderCancellationStockDispositionRequired } from "../lib/ecommerce-order-cancellation-stock.js";
import {
  deriveCodRefundRemittanceContext,
  resolveCodCollectionAmountPaise,
  suggestCodRefundFundingSource,
} from "../lib/ecommerce-courier-cod.js";
import { applyCancellationStockDispositionOnce } from "../lib/ecommerce-order-stock-restock.js";
import { findActivePaymentAttempt } from "../lib/ecommerce-payment-in-flight.js";
import {
  EcommerceCancellationStockDisposition,
  EcommerceOrderCancellationKind,
  EcommerceOrderCancellationRequestStatus,
  EcommerceOrderEventType,
  EcommerceOrderRefundSource,
  EcommerceOrderStatus,
  EcommercePaymentExceptionRefundStatus,
} from "../constants/enums.js";
import {
  EcommerceOrder,
  EcommerceOrderCancellationRequest,
  EcommerceOrderEvent,
  EcommercePaymentAttempt,
  EcommercePaymentExceptionRefund,
} from "../models/index.js";
import {
  ECOMMERCE_OUTBOX_TOPICS,
  enqueueEcommerceOutboxEvent,
} from "../lib/ecommerce-commerce-outbox.js";
export function mapCancellationRequest(row) {
  if (!row) return null;
  return {
    id: row._id,
    orderId: row.orderId,
    kind: row.kind,
    status: row.status,
    reason: row.reason,
    decisionReason: row.decisionReason ?? null,
    requesterType: row.requesterType ?? null,
    requesterId: row.requesterId ?? null,
    decidedAt: row.decidedAt ?? null,
    decidedByUserId: row.decidedByUserId ?? null,
    stockDisposition: row.stockDisposition ?? null,
    stockDispositionAt: row.stockDispositionAt ?? null,
    onlineRefundId: row.onlineRefundId ?? null,
    codManualRefund: row.codManualRefund ?? null,
    createdAt: row.createdAt ?? null,
    version: row.version ?? 1,
  };
}

export function mapCancellationCapabilities(order, attempt) {
  const inFlight = paymentAttemptBlocksCustomerCancel(attempt);
  const direct = customerDirectCancelEligible(order, { paymentInFlightBlocked: inFlight });
  const request = customerCancellationRequestEligible(order);
  return {
    directCancelAllowed: direct.allowed,
    directCancelBlockCode: direct.allowed ? null : direct.code,
    cancellationRequestAllowed: request.allowed,
    cancellationRequestBlockCode: request.allowed ? null : request.code,
    contactStoreForReturn: isShippedOrDelivered(order.status),
  };
}

async function loadCustomerOrder(req, session) {
  const order = await EcommerceOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).session(session);
  if (!order) throw errors.notFound("Order");
  return order;
}

async function loadTenantOrder(req, session) {
  const order = await EcommerceOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
  }).session(session);
  if (!order) throw errors.notFound("Order");
  return order;
}

async function attachActiveRequest(order, session) {
  if (!order.activeCancellationRequestId) return null;
  return EcommerceOrderCancellationRequest.findOne({
    _id: order.activeCancellationRequestId,
    tenantId: order.tenantId,
  })
    .session(session)
    .lean();
}

export async function getCustomerOrderCancellation(req) {
  const order = await EcommerceOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  if (!order) throw errors.notFound("Order");
  const attempt = await findActivePaymentAttempt(req.auth.tenantId, order._id);
  const request = order.activeCancellationRequestId
    ? await EcommerceOrderCancellationRequest.findById(order.activeCancellationRequestId).lean()
    : null;
  return {
    capabilities: mapCancellationCapabilities(order, attempt),
    request: mapCancellationRequest(request),
  };
}

export async function directCancelCustomerOrder(req) {
  const reason = String(req.body?.reason ?? "").trim();
  return withTransaction(async (session) => {
    const order = await loadCustomerOrder(req, session);
    const attempt = await findActivePaymentAttempt(req.auth.tenantId, order._id, session);
    const cap = customerDirectCancelEligible(order.toObject(), {
      paymentInFlightBlocked: paymentAttemptBlocksCustomerCancel(attempt),
    });
    if (!cap.allowed) {
      if (cap.code === "PAYMENT_IN_FLIGHT") {
        throw errors.business(
          "PAYMENT_IN_FLIGHT",
          "Payment may be processing. Wait or retry after the gateway settles.",
        );
      }
      throw errors.business("ORDER_NOT_CANCELLABLE", "This order cannot be cancelled directly.", {
        code: cap.code,
        status: order.status,
      });
    }
    const result =
      order.status === EcommerceOrderStatus.COD_PENDING_ACCEPTANCE
        ? await cancelCodPendingAcceptanceOrderRow({
            orderId: order._id,
            tenantId: req.auth.tenantId,
            customerId: req.auth.id,
            session,
          })
        : await cancelPendingPaymentOrderRow({
            orderId: order._id,
            tenantId: req.auth.tenantId,
            customerId: req.auth.id,
            session,
          });
    if (result.kind !== "OK") {
      throw errors.business("ORDER_NOT_CANCELLABLE", "Order could not be cancelled.", result);
    }
    await EcommerceOrderCancellationRequest.create(
      [
        {
          _id: createId("ecan"),
          tenantId: req.auth.tenantId,
          orderId: order._id,
          customerId: req.auth.id,
          kind: EcommerceOrderCancellationKind.CUSTOMER_DIRECT,
          status: EcommerceOrderCancellationRequestStatus.COMPLETED,
          reason: reason || "Customer cancelled before payment or acceptance.",
          requesterType: "CUSTOMER",
          requesterId: req.auth.id,
          decidedAt: new Date(),
          decidedByUserId: req.auth.id,
        },
      ],
      { session },
    );
    await EcommerceOrderEvent.create(
      [
        {
          _id: createId("eoev"),
          tenantId: req.auth.tenantId,
          orderId: order._id,
          type: EcommerceOrderEventType.CANCELLED,
          actorType: "CUSTOMER",
          actorId: req.auth.id,
          payload: { direct: true, stockReleaseReason: result.order.stockReleaseReason },
        },
      ],
      { session },
    );
    return { orderId: order._id, status: result.order.status, cancelled: true };
  });
}

async function resolveCancellationIdempotencyReplay({
  tenantId,
  customerId,
  orderId,
  idempotencyKey,
  bodyHash,
}) {
  const replay = await EcommerceOrderCancellationRequest.findOne({
    tenantId,
    idempotencyKey,
  }).lean();
  if (!replay) return null;
  if (replay.customerId !== customerId || replay.orderId !== orderId) {
    throw errors.conflict(
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency key was already used for a different order.",
    );
  }
  if (replay.creationBodyHash && replay.creationBodyHash !== bodyHash) {
    throw errors.conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency key reused with different body.");
  }
  return { request: mapCancellationRequest(replay), created: false };
}

export async function createCustomerCancellationRequest(req) {
  const reason = String(req.body?.reason ?? "").trim();
  if (reason.length < 8) {
    throw errors.validation([
      { field: "reason", message: "Please provide a cancellation reason (at least 8 characters)." },
    ]);
  }
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  const bodyHash = hashIdempotencyBody(req.body ?? {});
  const orderId = String(req.params.orderId ?? "").trim();
  if (idempotencyKey) {
    const crossScope = await EcommerceOrderCancellationRequest.findOne({
      tenantId: req.auth.tenantId,
      idempotencyKey,
      $or: [{ customerId: { $ne: req.auth.id } }, { orderId: { $ne: orderId } }],
    }).lean();
    if (crossScope) {
      throw errors.conflict(
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency key was already used for a different order.",
      );
    }
    const replay = await resolveCancellationIdempotencyReplay({
      tenantId: req.auth.tenantId,
      customerId: req.auth.id,
      orderId,
      idempotencyKey,
      bodyHash,
    });
    if (replay) return replay;
  }
  try {
    return await withTransaction(async (session) => {
    const order = await loadCustomerOrder(req, session);
    const cap = customerCancellationRequestEligible(order.toObject());
    if (!cap.allowed) {
      if (cap.code === "CONTACT_STORE_FOR_RETURN") {
        throw errors.business(
          "CONTACT_STORE_FOR_RETURN",
          "This order has shipped or been delivered. Contact the store for returns.",
        );
      }
      throw errors.business("CANCELLATION_REQUEST_NOT_ALLOWED", "Cancellation request is not allowed.", {
        code: cap.code,
        status: order.status,
      });
    }
    const requestId = createId("ecan");
    const row = (
      await EcommerceOrderCancellationRequest.create(
        [
          {
            _id: requestId,
            tenantId: req.auth.tenantId,
            orderId: order._id,
            customerId: req.auth.id,
            kind: EcommerceOrderCancellationKind.CUSTOMER_REQUEST,
            status: EcommerceOrderCancellationRequestStatus.PENDING_DECISION,
            reason,
            requesterType: "CUSTOMER",
            requesterId: req.auth.id,
            idempotencyKey: idempotencyKey || undefined,
            creationBodyHash: idempotencyKey ? bodyHash : undefined,
          },
        ],
        { session },
      )
    )[0];
    await EcommerceOrder.updateOne(
      { _id: order._id, tenantId: req.auth.tenantId, version: order.version },
      { $set: { activeCancellationRequestId: requestId }, $inc: { version: 1 } },
      { session },
    );
    await EcommerceOrderEvent.create(
      [
        {
          _id: createId("eoev"),
          tenantId: req.auth.tenantId,
          orderId: order._id,
          type: EcommerceOrderEventType.CANCELLATION_REQUESTED,
          actorType: "CUSTOMER",
          actorId: req.auth.id,
          payload: { cancellationRequestId: requestId, reason },
        },
      ],
      { session },
    );
    await enqueueEcommerceOutboxEvent({
      tenantId: req.auth.tenantId,
      topic: ECOMMERCE_OUTBOX_TOPICS.ORDER_UPDATED,
      key: order._id,
      payload: { orderId: order._id, cancellationRequestId: requestId },
      session,
    });
    return { request: mapCancellationRequest(row.toObject()), created: true };
    });
  } catch (err) {
    if (idempotencyKey && err?.code === 11000) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          const replay = await resolveCancellationIdempotencyReplay({
            tenantId: req.auth.tenantId,
            customerId: req.auth.id,
            orderId,
            idempotencyKey,
            bodyHash,
          });
          if (replay) return replay;
        } catch (replayErr) {
          if (replayErr?.code === "IDEMPOTENCY_KEY_REUSED") throw replayErr;
        }
        await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
      }
      throw errors.conflict(
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency key was already used for a different order.",
      );
    }
    throw err;
  }
}

export async function listAdminCancellationRequests(req) {
  const status = req.query.status ? String(req.query.status) : undefined;
  const filter = { tenantId: req.auth.tenantId };
  if (status) filter.status = status;
  const rows = await EcommerceOrderCancellationRequest.find(filter)
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(req.query.limit) || 50, 100))
    .lean();
  return { items: rows.map(mapCancellationRequest) };
}

export async function getAdminOrderCancellation(req) {
  const order = await EcommerceOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!order) throw errors.notFound("Order");
  const request = order.activeCancellationRequestId
    ? await EcommerceOrderCancellationRequest.findById(order.activeCancellationRequestId).lean()
    : null;
  const history = await EcommerceOrderCancellationRequest.find({
    tenantId: req.auth.tenantId,
    orderId: order._id,
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
  return {
    capabilities: {
      adminCancelAllowed: adminCancellationEligible(order).allowed,
      contactStoreForReturn: isShippedOrDelivered(order.status),
    },
    activeRequest: mapCancellationRequest(request),
    history: history.map(mapCancellationRequest),
  };
}

async function createOnlineCancellationRefundCase({ tenantId, order, cancellationRequestId, session }) {
  const attemptId = order.successfulPaymentAttemptId;
  if (!attemptId) throw errors.business("REFUND_NOT_APPLICABLE", "No successful payment on order.");
  const attempt = await EcommercePaymentAttempt.findOne({ _id: attemptId, tenantId }).session(session).lean();
  if (!attempt) throw errors.notFound("Payment attempt");
  const refundId = createId("epayref");
  const row = (
    await EcommercePaymentExceptionRefund.findOneAndUpdate(
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
          refundSource: EcommerceOrderRefundSource.ORDER_CANCELLATION,
          cancellationRequestId,
        },
      },
      { session, upsert: true, new: true },
    )
  );
  return row;
}

export async function decideAdminCancellationRequest(req) {
  const decision = String(req.body.decision ?? "").trim().toUpperCase();
  const decisionReason = String(req.body.decisionReason ?? "").trim();
  const expectedVersion = Number(req.body.expectedVersion);
  const stockDisposition = req.body.stockDisposition
    ? String(req.body.stockDisposition).trim()
    : null;
  if (!["APPROVE", "REJECT"].includes(decision)) {
    throw errors.validation([{ field: "decision", message: "decision must be APPROVE or REJECT." }]);
  }
  if (!Number.isInteger(expectedVersion)) {
    throw errors.validation([{ field: "expectedVersion", message: "expectedVersion is required." }]);
  }
  if (decision === "REJECT" && decisionReason.length < 8) {
    throw errors.validation([
      { field: "decisionReason", message: "Rejection reason must be at least 8 characters." },
    ]);
  }

  const txResult = await withTransaction(async (session) => {
    const order = await loadTenantOrder(req, session);
    const request = await attachActiveRequest(order, session);
    if (!request || request.status !== EcommerceOrderCancellationRequestStatus.PENDING_DECISION) {
      throw errors.business("NO_PENDING_CANCELLATION", "No pending cancellation request on this order.");
    }
    if (Number(request.version ?? 0) !== expectedVersion) {
      throw errors.conflict("VERSION_CONFLICT", "Cancellation request changed elsewhere.");
    }
    if (isShippedOrDelivered(order.status)) {
      throw errors.business("CONTACT_STORE_FOR_RETURN", "Shipped or delivered orders cannot be cancelled here.");
    }

    if (decision === "REJECT") {
      const updatedReq = await EcommerceOrderCancellationRequest.findOneAndUpdate(
        { _id: request._id, tenantId: req.auth.tenantId, version: expectedVersion },
        {
          $set: {
            status: EcommerceOrderCancellationRequestStatus.REJECTED,
            decisionReason,
            decidedAt: new Date(),
            decidedByUserId: req.auth.id,
          },
          $inc: { version: 1 },
        },
        { session, new: true },
      );
      if (!updatedReq) throw errors.conflict("VERSION_CONFLICT", "Cancellation request changed elsewhere.");
      await EcommerceOrder.updateOne(
        { _id: order._id, tenantId: req.auth.tenantId },
        { $unset: { activeCancellationRequestId: "" }, $inc: { version: 1 } },
        { session },
      );
      await EcommerceOrderEvent.create(
        [
          {
            _id: createId("eoev"),
            tenantId: req.auth.tenantId,
            orderId: order._id,
            type: EcommerceOrderEventType.CANCELLATION_REJECTED,
            actorType: "STAFF",
            actorId: req.auth.id,
            payload: { cancellationRequestId: request._id, decisionReason },
          },
        ],
        { session },
      );
      await enqueueEcommerceOutboxEvent({
        tenantId: req.auth.tenantId,
        topic: ECOMMERCE_OUTBOX_TOPICS.ORDER_UPDATED,
        key: `${order._id}:cancel-reject:${request._id}`,
        payload: { orderId: order._id, cancellationRequestId: request._id },
        session,
      });
      return { kind: "REJECTED", request: updatedReq.toObject(), orderId: order._id };
    }

    const needsStock = await orderCancellationStockDispositionRequired(order.toObject(), session);
    if (needsStock && !stockDisposition) {
      throw errors.validation([
        {
          field: "stockDisposition",
          message: "stockDisposition (RESTOCK_CONFIRMED or STOCK_EXCEPTION) is required.",
        },
      ]);
    }
    if (
      stockDisposition
      && !Object.values(EcommerceCancellationStockDisposition).includes(stockDisposition)
    ) {
      throw errors.validation([{ field: "stockDisposition", message: "Invalid stock disposition." }]);
    }

    const updatedReq = await EcommerceOrderCancellationRequest.findOneAndUpdate(
      { _id: request._id, tenantId: req.auth.tenantId, version: expectedVersion },
      {
        $set: {
          status: EcommerceOrderCancellationRequestStatus.APPROVED_PROCESSING,
          decisionReason: decisionReason || "Approved",
          decidedAt: new Date(),
          decidedByUserId: req.auth.id,
          stockDisposition: needsStock ? stockDisposition : undefined,
          stockDispositionAt: needsStock ? new Date() : undefined,
          stockDispositionByUserId: needsStock ? req.auth.id : undefined,
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    );
    if (!updatedReq) throw errors.conflict("VERSION_CONFLICT", "Cancellation request changed elsewhere.");

    if (needsStock) {
      await applyCancellationStockDispositionOnce({
        tenantId: req.auth.tenantId,
        orderId: order._id,
        disposition: stockDisposition,
        actorUserId: req.auth.id,
        idempotencyKey: `cancel-stock:${request._id}`,
        session,
      });
      await EcommerceOrderEvent.create(
        [
          {
            _id: createId("eoev"),
            tenantId: req.auth.tenantId,
            orderId: order._id,
            type: EcommerceOrderEventType.CANCELLATION_STOCK_DISPOSITION,
            actorType: "STAFF",
            actorId: req.auth.id,
            payload: { disposition: stockDisposition, cancellationRequestId: request._id },
          },
        ],
        { session },
      );
    }

    if (cancellationNeedsOnlineRefund(order.toObject())) {
      const refundRow = await createOnlineCancellationRefundCase({
        tenantId: req.auth.tenantId,
        order: order.toObject(),
        cancellationRequestId: request._id,
        session,
      });
      await EcommerceOrderCancellationRequest.updateOne(
        { _id: request._id },
        { $set: { onlineRefundId: refundRow._id } },
        { session },
      );
      await EcommerceOrder.findOneAndUpdate(
        { _id: order._id, tenantId: req.auth.tenantId },
        { $set: { status: EcommerceOrderStatus.REFUND_PENDING }, $inc: { version: 1 } },
        { session },
      );
      await EcommerceOrderEvent.create(
        [
          {
            _id: createId("eoev"),
            tenantId: req.auth.tenantId,
            orderId: order._id,
            type: EcommerceOrderEventType.CANCELLATION_APPROVED,
            actorType: "STAFF",
            actorId: req.auth.id,
            payload: {
              cancellationRequestId: request._id,
              onlineRefundId: refundRow._id,
              refundPending: true,
            },
          },
        ],
        { session },
      );
      await enqueueEcommerceOutboxEvent({
        tenantId: req.auth.tenantId,
        topic: ECOMMERCE_OUTBOX_TOPICS.ORDER_UPDATED,
        key: `${order._id}:cancel-approve:${request._id}`,
        payload: { orderId: order._id, cancellationRequestId: request._id },
        session,
      });
      return {
        kind: "APPROVED_ONLINE_REFUND",
        request: updatedReq.toObject(),
        orderId: order._id,
        refundId: refundRow._id,
      };
    }

    if (cancellationNeedsCodManualRefund(order.toObject())) {
      await EcommerceOrderCancellationRequest.updateOne(
        { _id: request._id },
        {
          $set: {
            codRefundContext: {
              remittanceContext: deriveCodRefundRemittanceContext(order.toObject()),
              fundingSource: suggestCodRefundFundingSource(order.toObject()),
              capturedAt: new Date(),
              note: "Snapshot at cancellation approval; refund execution requires separate evidence.",
            },
          },
        },
        { session },
      );
      await EcommerceOrderEvent.create(
        [
          {
            _id: createId("eoev"),
            tenantId: req.auth.tenantId,
            orderId: order._id,
            type: EcommerceOrderEventType.CANCELLATION_APPROVED,
            actorType: "STAFF",
            actorId: req.auth.id,
            payload: {
              cancellationRequestId: request._id,
              codManualRefundRequired: true,
            },
          },
        ],
        { session },
      );
      await enqueueEcommerceOutboxEvent({
        tenantId: req.auth.tenantId,
        topic: ECOMMERCE_OUTBOX_TOPICS.ORDER_UPDATED,
        key: `${order._id}:cancel-approve:${request._id}`,
        payload: { orderId: order._id, cancellationRequestId: request._id },
        session,
      });
      return {
        kind: "APPROVED_COD_MANUAL",
        request: updatedReq.toObject(),
        orderId: order._id,
      };
    }

    await EcommerceOrder.findOneAndUpdate(
      { _id: order._id, tenantId: req.auth.tenantId },
      { $set: { status: EcommerceOrderStatus.CANCELLED }, $inc: { version: 1 } },
      { session },
    );
    await EcommerceOrderCancellationRequest.updateOne(
      { _id: request._id },
      { $set: { status: EcommerceOrderCancellationRequestStatus.COMPLETED } },
      { session },
    );
    await EcommerceOrder.updateOne(
      { _id: order._id },
      { $unset: { activeCancellationRequestId: "" } },
      { session },
    );
    await EcommerceOrderEvent.create(
      [
        {
          _id: createId("eoev"),
          tenantId: req.auth.tenantId,
          orderId: order._id,
          type: EcommerceOrderEventType.CANCELLATION_COMPLETED,
          actorType: "STAFF",
          actorId: req.auth.id,
          payload: { cancellationRequestId: request._id },
        },
      ],
      { session },
    );
    await enqueueEcommerceOutboxEvent({
      tenantId: req.auth.tenantId,
      topic: ECOMMERCE_OUTBOX_TOPICS.ORDER_UPDATED,
      key: `${order._id}:cancel-approve:${request._id}`,
      payload: { orderId: order._id, cancellationRequestId: request._id },
      session,
    });
    return { kind: "APPROVED_COMPLETED", request: updatedReq.toObject(), orderId: order._id };
  });

  return {
    decision,
    request: mapCancellationRequest(txResult.request),
    orderId: txResult.orderId,
    refundCaseCreated: txResult.kind === "APPROVED_ONLINE_REFUND",
    refundInitiationRequired:
      txResult.kind === "APPROVED_ONLINE_REFUND" ? true : undefined,
  };
}

export async function recordCodCancellationManualRefund(req) {
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
    const order = await loadTenantOrder(req, session);
    const request = await attachActiveRequest(order, session);
    if (!request || request.status !== EcommerceOrderCancellationRequestStatus.APPROVED_PROCESSING) {
      throw errors.business("NO_APPROVED_CANCELLATION", "No approved cancellation awaiting COD refund.");
    }
    if (!cancellationNeedsCodManualRefund(order.toObject())) {
      throw errors.business("COD_MANUAL_REFUND_NOT_APPLICABLE", "Order does not require COD manual refund.");
    }
    const collectedPaise = resolveCodCollectionAmountPaise(order.toObject());
    const orderTotalPaise = Number(order.totalPaise);
    if (!Number.isInteger(collectedPaise) || collectedPaise <= 0) {
      throw errors.business(
        "COD_COLLECTION_MISSING",
        "Courier COD collection is not confirmed on this order.",
      );
    }
    if (collectedPaise !== orderTotalPaise) {
      throw errors.business(
        "COD_COLLECTION_AMOUNT_MISMATCH",
        "Confirmed COD amount does not match order total; resolve before refund.",
      );
    }
    if (amountPaise !== collectedPaise) {
      throw errors.validation([
        {
          field: "amountPaise",
          message: `Refund amount must exactly match collected COD amount (${collectedPaise} paise).`,
        },
      ]);
    }
    if (request.codManualRefund?.recordedAt) {
      return { request: mapCancellationRequest(request), recorded: false };
    }
    const updatedReq = await EcommerceOrderCancellationRequest.findOneAndUpdate(
      {
        _id: request._id,
        tenantId: req.auth.tenantId,
        "codManualRefund.recordedAt": { $exists: false },
      },
      {
        $set: {
          codManualRefund: {
            amountPaise,
            recipient,
            method,
            reference,
            proofNote,
            recordedAt: new Date(),
            recordedByUserId: req.auth.id,
            idempotencyKey: idempotencyKey || undefined,
          },
          status: EcommerceOrderCancellationRequestStatus.COMPLETED,
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    );
    if (!updatedReq) throw errors.conflict("REFUND_ALREADY_RECORDED", "COD refund already recorded.");
    await EcommerceOrder.findOneAndUpdate(
      { _id: order._id, tenantId: req.auth.tenantId },
      { $set: { status: EcommerceOrderStatus.CANCELLED }, $unset: { activeCancellationRequestId: "" }, $inc: { version: 1 } },
      { session },
    );
    await EcommerceOrderEvent.create(
      [
        {
          _id: createId("eoev"),
          tenantId: req.auth.tenantId,
          orderId: order._id,
          type: EcommerceOrderEventType.COD_MANUAL_REFUND_RECORDED,
          actorType: "STAFF",
          actorId: req.auth.id,
          payload: { cancellationRequestId: request._id, amountPaise, reference },
        },
        {
          _id: createId("eoev"),
          tenantId: req.auth.tenantId,
          orderId: order._id,
          type: EcommerceOrderEventType.CANCELLATION_COMPLETED,
          actorType: "STAFF",
          actorId: req.auth.id,
          payload: { cancellationRequestId: request._id },
        },
      ],
      { session, ordered: true },
    );
    return { request: mapCancellationRequest(updatedReq.toObject()), recorded: true };
  });
}

export async function completeOnlineCancellationAfterRefund({
  tenantId,
  orderId,
  refundId,
  session,
}) {
  const request = await EcommerceOrderCancellationRequest.findOne({
    tenantId,
    orderId,
    onlineRefundId: refundId,
    status: EcommerceOrderCancellationRequestStatus.APPROVED_PROCESSING,
  })
    .session(session)
    .lean();
  if (!request) return;
  await EcommerceOrder.findOneAndUpdate(
    { _id: orderId, tenantId },
    {
      $set: { status: EcommerceOrderStatus.REFUNDED },
      $unset: { activeCancellationRequestId: "" },
      $inc: { version: 1 },
    },
    { session },
  );
  await EcommerceOrderCancellationRequest.updateOne(
    { _id: request._id },
    { $set: { status: EcommerceOrderCancellationRequestStatus.COMPLETED } },
    { session },
  );
  await EcommerceOrderEvent.create(
    [
      {
        _id: createId("eoev"),
        tenantId,
        orderId,
        type: EcommerceOrderEventType.CANCELLATION_COMPLETED,
        actorType: "SYSTEM",
        payload: { cancellationRequestId: request._id, refundId },
      },
    ],
    { session },
  );
}

export async function adminInitiateCancellation(req) {
  const reason = String(req.body.reason ?? "").trim();
  const expectedVersion = Number(req.body.expectedVersion);
  const stockDisposition = req.body.stockDisposition
    ? String(req.body.stockDisposition).trim()
    : null;
  if (reason.length < 8) {
    throw errors.validation([{ field: "reason", message: "Reason must be at least 8 characters." }]);
  }
  if (!Number.isInteger(expectedVersion)) {
    throw errors.validation([{ field: "expectedVersion", message: "expectedVersion is required." }]);
  }
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  let requestVersion = 1;
  await withTransaction(async (session) => {
    const order = await loadTenantOrder(req, session);
    if (Number(order.version ?? 0) !== expectedVersion) {
      throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere.");
    }
    const cap = adminCancellationEligible(order.toObject());
    if (!cap.allowed) {
      throw errors.business("ORDER_NOT_ADMIN_CANCELLABLE", "Order cannot be cancelled by staff.", cap);
    }
    const requestId = createId("ecan");
    const row = (
      await EcommerceOrderCancellationRequest.create(
        [
          {
            _id: requestId,
            tenantId: req.auth.tenantId,
            orderId: order._id,
            customerId: order.customerId,
            kind: EcommerceOrderCancellationKind.ADMIN_INITIATED,
            status: EcommerceOrderCancellationRequestStatus.PENDING_DECISION,
            reason,
            requesterType: "STAFF",
            requesterId: req.auth.id,
            idempotencyKey: idempotencyKey || undefined,
          },
        ],
        { session },
      )
    )[0];
    requestVersion = row.version ?? 1;
    await EcommerceOrder.updateOne(
      { _id: order._id, version: expectedVersion },
      { $set: { activeCancellationRequestId: requestId }, $inc: { version: 1 } },
      { session },
    );
  });
  req.body = {
    decision: "APPROVE",
    decisionReason: reason,
    expectedVersion: requestVersion,
    stockDisposition,
  };
  return decideAdminCancellationRequest(req);
}
