import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import {
  AlertType,
  EcommerceOrderEventType,
  EcommerceOrderPaymentExceptionStatus,
  EcommerceOrderStatus,
  EcommercePaymentExceptionRefundStatus,
} from "../constants/enums.js";
import {
  EcommerceOrder,
  EcommerceOrderEvent,
  EcommercePaymentAttempt,
  EcommercePaymentExceptionRefund,
  Tenant,
} from "../models/index.js";
import {
  callbackTypeKey,
  phonePeProvider,
  resolvePhonePeCredentials,
} from "../integrations/phonepe.provider.js";
import {
  ECOMMERCE_OUTBOX_TOPICS,
  enqueueEcommerceOutboxEvent,
} from "../lib/ecommerce-commerce-outbox.js";
import { upsertOperationalAlert } from "../lib/operational-alert.js";
import {
  isEcommercePaymentExceptionRefundMerchantId,
  isEcommercePaymentMerchantOrderId,
} from "../lib/ecommerce-payment-reference.js";

function refundCallbackKind(type) {
  const key = callbackTypeKey(type);
  if (key === "PG_REFUND_COMPLETED") return "COMPLETED";
  if (key === "PG_REFUND_FAILED") return "FAILED";
  if (key === "PG_REFUND_ACCEPTED") return "ACCEPTED";
  return "UNKNOWN";
}

function parseRefundAmountPaise(payload) {
  const amount = Number(payload.amount ?? payload.refundAmount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}

function refundCurrencyValid(payload) {
  const currency = payload.currency ?? payload.currencyCode ?? payload.currency_code;
  if (!currency) return true;
  const normalized = String(currency).toUpperCase();
  return normalized === "INR" || normalized === "IN";
}

const TERMINAL_REFUND_STATUSES = new Set([
  EcommercePaymentExceptionRefundStatus.SUCCEEDED,
  EcommercePaymentExceptionRefundStatus.MANUAL_RECORDED,
]);

async function resolveExceptionRefundCase({ tenantId, payload }) {
  const providerRefundId = payload.refundId ?? payload.merchantRefundId ?? null;
  const originalMerchantOrderId =
    payload.originalMerchantOrderId ?? payload.merchantOrderId ?? null;

  if (providerRefundId) {
    const byProvider = await EcommercePaymentExceptionRefund.findOne({
      tenantId,
      providerRefundId: String(providerRefundId),
    }).lean();
    if (byProvider) return byProvider;
  }
  if (providerRefundId && isEcommercePaymentExceptionRefundMerchantId(providerRefundId)) {
    const byId = await EcommercePaymentExceptionRefund.findOne({
      _id: providerRefundId,
      tenantId,
    }).lean();
    if (byId) return byId;
  }
  if (originalMerchantOrderId && isEcommercePaymentMerchantOrderId(originalMerchantOrderId)) {
    return EcommercePaymentExceptionRefund.findOne({
      tenantId,
      merchantOrderId: originalMerchantOrderId,
    }).lean();
  }
  return null;
}

async function assertRefundPaymentReference(refundCase, payload) {
  const originalMerchantOrderId =
    payload.originalMerchantOrderId ?? payload.merchantOrderId ?? null;
  const attempt = await EcommercePaymentAttempt.findOne({
    _id: refundCase.paymentAttemptId,
    tenantId: refundCase.tenantId,
  }).lean();
  if (!attempt) return { ok: false, code: "ATTEMPT_MISSING" };
  const expectedMerchant = attempt.merchantOrderId ?? attempt._id;
  if (
    originalMerchantOrderId
    && originalMerchantOrderId !== expectedMerchant
    && originalMerchantOrderId !== attempt._id
  ) {
    return { ok: false, code: "ORIGINAL_PAYMENT_MISMATCH" };
  }
  if (
    refundCase.merchantOrderId
    && originalMerchantOrderId
    && refundCase.merchantOrderId !== originalMerchantOrderId
  ) {
    return { ok: false, code: "CASE_MERCHANT_MISMATCH" };
  }
  return { ok: true, attempt };
}
export async function getAdminPaymentExceptionRefund(req) {
  const order = await EcommerceOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!order) throw errors.notFound("Order");
  const row = await EcommercePaymentExceptionRefund.findOne({
    tenantId: req.auth.tenantId,
    orderId: order._id,
  }).lean();
  return { orderId: order._id, refund: row ?? null };
}

const REFUND_APPLICABLE_EXCEPTIONS = new Set([
  EcommerceOrderPaymentExceptionStatus.LATE_SUCCESS_REFUND_REQUIRED,
  EcommerceOrderPaymentExceptionStatus.DUPLICATE_PAYMENT_REFUND_REQUIRED,
]);

export async function initiateAdminPaymentExceptionRefund(req) {
  const order = await EcommerceOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!order) throw errors.notFound("Order");
  if (!REFUND_APPLICABLE_EXCEPTIONS.has(order.paymentExceptionStatus)) {
    throw errors.business("REFUND_NOT_APPLICABLE", "Order has no payment exception refund case.");
  }
  if (
    order.status === EcommerceOrderStatus.PAID
    && order.paymentExceptionStatus
      !== EcommerceOrderPaymentExceptionStatus.DUPLICATE_PAYMENT_REFUND_REQUIRED
  ) {
    throw errors.business("REFUND_NOT_APPLICABLE", "Paid orders use standard refund flows.");
  }

  const refundRow = await EcommercePaymentExceptionRefund.findOne({
    tenantId: req.auth.tenantId,
    orderId: order._id,
  }).lean();
  if (!refundRow) throw errors.notFound("Payment exception refund");
  if (TERMINAL_REFUND_STATUSES.has(refundRow.status)) {
    return { refund: refundRow, initiated: false };
  }
  if (
    refundRow.status === EcommercePaymentExceptionRefundStatus.PROVIDER_PENDING
    || refundRow.status === EcommercePaymentExceptionRefundStatus.INITIATED
  ) {
    return { refund: refundRow, initiated: false, inFlight: true };
  }

  const merchantRefundId = refundRow._id;
  let claimed;
  try {
    claimed = await withTransaction(async (session) => {
      const updated = await EcommercePaymentExceptionRefund.findOneAndUpdate(
        {
          _id: refundRow._id,
          tenantId: req.auth.tenantId,
          status: {
            $in: [
              EcommercePaymentExceptionRefundStatus.ASSIGNED,
              EcommercePaymentExceptionRefundStatus.FAILED,
            ],
          },
        },
        {
          $set: {
            status: EcommercePaymentExceptionRefundStatus.INITIATED,
            assignedUserId: req.auth.id,
            providerRefundId: merchantRefundId,
          },
          $inc: { version: 1 },
        },
        { session, new: true },
      );
      if (!updated) {
        const current = await EcommercePaymentExceptionRefund.findOne({
          _id: refundRow._id,
          tenantId: req.auth.tenantId,
        })
          .session(session)
          .lean();
        if (current && TERMINAL_REFUND_STATUSES.has(current.status)) {
          return { kind: "DONE", refund: current };
        }
        if (
          current?.status === EcommercePaymentExceptionRefundStatus.PROVIDER_PENDING
          || current?.status === EcommercePaymentExceptionRefundStatus.INITIATED
        ) {
          return { kind: "IN_FLIGHT", refund: current };
        }
        throw errors.conflict("REFUND_STATE_RACE", "Refund case changed elsewhere.");
      }
      await EcommerceOrderEvent.create(
        [
          {
            _id: createId("eoev"),
            tenantId: req.auth.tenantId,
            orderId: order._id,
            type: EcommerceOrderEventType.REFUND_INITIATED,
            actorType: "STAFF",
            actorId: req.auth.id,
            payload: { refundId: updated._id, merchantRefundId },
          },
        ],
        { session },
      );
      return { kind: "CALL_PROVIDER", refund: updated.toObject() };
    });
  } catch (err) {
    if (err?.code === 11000) {
      const current = await EcommercePaymentExceptionRefund.findById(refundRow._id).lean();
      if (current) return { refund: current, initiated: false, inFlight: true };
    }
    throw err;
  }

  if (claimed.kind === "DONE") {
    return { refund: claimed.refund, initiated: false };
  }
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
    const updated = await EcommercePaymentExceptionRefund.findOneAndUpdate(
      {
        _id: refundRow._id,
        tenantId: req.auth.tenantId,
        status: EcommercePaymentExceptionRefundStatus.INITIATED,
      },
      {
        $set: {
          status: EcommercePaymentExceptionRefundStatus.PROVIDER_PENDING,
          providerRefundId: provider.refundId ?? merchantRefundId,
          providerPayload: provider,
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    if (!updated) {
      const current = await EcommercePaymentExceptionRefund.findById(refundRow._id).lean();
      return { refund: current ?? claimed.refund, initiated: false, inFlight: true };
    }
    return { refund: updated.toObject(), initiated: true };
  } catch (error) {
    await EcommercePaymentExceptionRefund.updateOne(
      {
        _id: refundRow._id,
        tenantId: req.auth.tenantId,
        status: EcommercePaymentExceptionRefundStatus.INITIATED,
      },
      {
        $set: {
          status: EcommercePaymentExceptionRefundStatus.PROVIDER_PENDING,
          failureReason: "PROVIDER_INITIATION_UNCERTAIN",
        },
        $inc: { version: 1 },
      },
    );
    if (error instanceof AppError) throw error;
    throw errors.business(
      "REFUND_INITIATION_UNCERTAIN",
      "Refund may have started at the provider. Reconcile or retry with the same merchant refund id.",
      { refundId: refundRow._id, merchantRefundId },
    );
  }
}

export async function recordAdminPaymentExceptionRefundManual(req) {
  const reference = String(req.body.providerRefundReference ?? "").trim();
  const reason = String(req.body.reason ?? "").trim();
  const evidenceNote = String(req.body.evidenceNote ?? "").trim();
  if (!reference) {
    throw errors.validation([
      { field: "providerRefundReference", message: "Provider refund reference is required." },
    ]);
  }
  if (!reason || reason.length < 8) {
    throw errors.validation([
      { field: "reason", message: "A reason of at least 8 characters is required for manual recording." },
    ]);
  }
  if (!evidenceNote || evidenceNote.length < 8) {
    throw errors.validation([
      { field: "evidenceNote", message: "Evidence note of at least 8 characters is required." },
    ]);
  }
  const order = await EcommerceOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!order) throw errors.notFound("Order");

  return withTransaction(async (session) => {
    const updated = await EcommercePaymentExceptionRefund.findOneAndUpdate(
      {
        tenantId: req.auth.tenantId,
        orderId: order._id,
        status: {
          $nin: [
            EcommercePaymentExceptionRefundStatus.SUCCEEDED,
            EcommercePaymentExceptionRefundStatus.MANUAL_RECORDED,
          ],
        },
      },
      {
        $set: {
          status: EcommercePaymentExceptionRefundStatus.MANUAL_RECORDED,
          providerRefundId: reference,
          assignedUserId: req.auth.id,
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    );
    if (!updated) {
      throw new AppError("REFUND_ALREADY_CLOSED", "Refund case is already completed.", 409);
    }
    await EcommerceOrderEvent.create(
      [
        {
          _id: createId("eoev"),
          tenantId: req.auth.tenantId,
          orderId: order._id,
          type: EcommerceOrderEventType.REFUND_CONFIRMED,
          actorType: "STAFF",
          actorId: req.auth.id,
          payload: {
            refundId: updated._id,
            manual: true,
            reference,
            reason,
            evidenceNote,
          },
        },
      ],
      { session },
    );
    await enqueueEcommerceOutboxEvent({
      tenantId: req.auth.tenantId,
      topic: ECOMMERCE_OUTBOX_TOPICS.REFUND_COMPLETED,
      key: `${order._id}:manual`,
      payload: { orderId: order._id, refundId: updated._id, manual: true },
      session,
    });
    return { refund: updated.toObject() };
  });
}

export async function confirmPaymentExceptionRefundFromProvider({
  tenantId,
  orderId,
  refundCaseId,
  providerRefundId,
  amountPaise,
  currency,
  providerPayload,
  session,
}) {
  const existing = await EcommercePaymentExceptionRefund.findOne({
    tenantId,
    orderId,
    _id: refundCaseId,
  })
    .session(session)
    .lean();
  if (!existing) return { outcome: "NOT_FOUND" };
  if (TERMINAL_REFUND_STATUSES.has(existing.status)) {
    return { outcome: "ALREADY_CLOSED", refund: existing };
  }
  if (existing.providerRefundId && providerRefundId && existing.providerRefundId !== providerRefundId) {
    return { outcome: "REFUND_ID_MISMATCH" };
  }
  if (Number(amountPaise) !== Number(existing.amountPaise)) {
    return { outcome: "AMOUNT_MISMATCH" };
  }
  const caseCurrency = String(existing.currency ?? "INR").toUpperCase();
  const payloadCurrency = String(currency ?? caseCurrency).toUpperCase();
  if (caseCurrency !== payloadCurrency) {
    return { outcome: "CURRENCY_MISMATCH" };
  }

  const updated = await EcommercePaymentExceptionRefund.findOneAndUpdate(
    {
      _id: refundCaseId,
      tenantId,
      orderId,
      status: {
        $in: [
          EcommercePaymentExceptionRefundStatus.PROVIDER_PENDING,
          EcommercePaymentExceptionRefundStatus.INITIATED,
          EcommercePaymentExceptionRefundStatus.ASSIGNED,
        ],
      },
    },
    {
      $set: {
        status: EcommercePaymentExceptionRefundStatus.SUCCEEDED,
        providerRefundId: providerRefundId ?? existing.providerRefundId,
        providerPayload,
      },
      $inc: { version: 1 },
    },
    { session, new: true },
  );
  if (!updated) {
    const replay = await EcommercePaymentExceptionRefund.findOne({
      _id: refundCaseId,
      tenantId,
      status: EcommercePaymentExceptionRefundStatus.SUCCEEDED,
    })
      .session(session)
      .lean();
    if (replay) return { outcome: "ALREADY_CLOSED", refund: replay };
    return { outcome: "STATE_RACE" };
  }
  await EcommerceOrderEvent.create(
    [
      {
        _id: createId("eoev"),
        tenantId,
        orderId,
        type: EcommerceOrderEventType.REFUND_CONFIRMED,
        actorType: "SYSTEM",
        payload: { refundId: updated._id, providerRefundId: updated.providerRefundId },
      },
    ],
    { session },
  );
  await enqueueEcommerceOutboxEvent({
    tenantId,
    topic: ECOMMERCE_OUTBOX_TOPICS.REFUND_COMPLETED,
    key: `${orderId}:${updated._id}`,
    payload: { orderId, refundId: updated._id },
    session,
  });
  return { outcome: "SUCCEEDED", refund: updated.toObject() };
}

async function recordVerifiedRefundFailure({
  tenantId,
  refundCase,
  providerRefundId,
  providerPayload,
  failureReason,
  session,
}) {
  if (TERMINAL_REFUND_STATUSES.has(refundCase.status)) {
    return { outcome: "ALREADY_CLOSED", refund: refundCase };
  }
  const updated = await EcommercePaymentExceptionRefund.findOneAndUpdate(
    {
      _id: refundCase._id,
      tenantId,
      status: {
        $nin: [
          EcommercePaymentExceptionRefundStatus.SUCCEEDED,
          EcommercePaymentExceptionRefundStatus.MANUAL_RECORDED,
        ],
      },
    },
    {
      $set: {
        status: EcommercePaymentExceptionRefundStatus.FAILED,
        providerRefundId: providerRefundId ?? refundCase.providerRefundId,
        failureReason: String(failureReason ?? "PROVIDER_REFUND_FAILED").slice(0, 500),
        providerPayload,
      },
      $inc: { version: 1 },
    },
    { session, new: true },
  );
  if (!updated) return { outcome: "STATE_RACE" };
  await EcommerceOrderEvent.create(
    [
      {
        _id: createId("eoev"),
        tenantId,
        orderId: refundCase.orderId,
        type: EcommerceOrderEventType.REFUND_FAILED,
        actorType: "SYSTEM",
        payload: { refundId: updated._id, providerRefundId: updated.providerRefundId },
      },
    ],
    { session },
  );
  await upsertOperationalAlert({
    tenantId,
    type: AlertType.PAYMENT_REVIEW,
    entityId: refundCase.orderId,
    title: "Ecommerce exception refund failed at provider",
    message: "Provider reported refund failure. Retry initiation or record manual resolution with evidence.",
    metadata: {
      orderId: refundCase.orderId,
      refundCaseId: refundCase._id,
      providerRefundId: updated.providerRefundId,
    },
  });
  return { outcome: "FAILED", refund: updated.toObject() };
}

export async function processEcommercePhonePeRefundWebhook({
  tenantId,
  type,
  payload = {},
  providerEventId,
}) {
  const kind = refundCallbackKind(type);
  if (kind === "UNKNOWN") return { outcome: "IGNORED" };

  const refundCase = await resolveExceptionRefundCase({ tenantId, payload });
  if (!refundCase) {
    await upsertOperationalAlert({
      tenantId,
      type: AlertType.PAYMENT_REVIEW,
      entityId: providerEventId ?? createId("epayref"),
      title: "Unmatched ecommerce refund callback",
      message: "Refund webhook did not match a payment exception refund case.",
      metadata: { type: callbackTypeKey(type), payload },
    });
    return { outcome: "UNMATCHED" };
  }

  const referenceCheck = await assertRefundPaymentReference(refundCase, payload);
  if (!referenceCheck.ok) {
    await upsertOperationalAlert({
      tenantId,
      type: AlertType.PAYMENT_REVIEW,
      entityId: refundCase.orderId,
      title: "Ecommerce refund reference mismatch",
      message: `Refund callback failed validation (${referenceCheck.code}).`,
      metadata: { orderId: refundCase.orderId, refundCaseId: refundCase._id, payload },
    });
    return { outcome: referenceCheck.code };
  }

  const providerRefundId =
    payload.refundId ?? payload.merchantRefundId ?? refundCase.providerRefundId ?? providerEventId;

  if (kind === "ACCEPTED") {
    if (TERMINAL_REFUND_STATUSES.has(refundCase.status)) {
      return { outcome: "ALREADY_CLOSED", refundId: refundCase._id };
    }
    await EcommercePaymentExceptionRefund.updateOne(
      {
        _id: refundCase._id,
        tenantId,
        status: { $nin: [...TERMINAL_REFUND_STATUSES] },
      },
      {
        $set: {
          status: EcommercePaymentExceptionRefundStatus.PROVIDER_PENDING,
          providerRefundId,
          providerPayload: payload,
        },
      },
    );
    return { outcome: "ACCEPTED", refundId: refundCase._id };
  }

  if (kind === "FAILED") {
    return withTransaction(async (session) =>
      recordVerifiedRefundFailure({
        tenantId,
        refundCase,
        providerRefundId,
        providerPayload: payload,
        failureReason: payload.reason ?? payload.failureReason ?? "PROVIDER_REFUND_FAILED",
        session,
      }),
    );
  }

  if (kind === "COMPLETED") {
    const amountPaise = parseRefundAmountPaise(payload);
    if (!amountPaise) {
      await upsertOperationalAlert({
        tenantId,
        type: AlertType.PAYMENT_REVIEW,
        entityId: refundCase.orderId,
        title: "Invalid ecommerce refund amount",
        message: "Refund completed callback missing a valid amount.",
        metadata: { refundCaseId: refundCase._id, providerRefundId },
      });
      return { outcome: "INVALID_AMOUNT" };
    }
    if (!refundCurrencyValid(payload)) {
      return { outcome: "CURRENCY_MISMATCH" };
    }
    return withTransaction(async (session) =>
      confirmPaymentExceptionRefundFromProvider({
        tenantId,
        orderId: refundCase.orderId,
        refundCaseId: refundCase._id,
        providerRefundId,
        amountPaise,
        currency: payload.currency ?? refundCase.currency ?? "INR",
        providerPayload: payload,
        session,
      }),
    );
  }

  return { outcome: "IGNORED" };
}

export async function listAdminPaymentExceptions(req) {
  const tenantId = req.auth.tenantId;
  const limit = Math.min(Number(req.query.limit) || 50, 100);

  const [refundRows, stuckAttempts, uncertainAttempts, exceptionOrders] = await Promise.all([
    EcommercePaymentExceptionRefund.find({
      tenantId,
      status: {
        $in: [
          EcommercePaymentExceptionRefundStatus.ASSIGNED,
          EcommercePaymentExceptionRefundStatus.INITIATED,
          EcommercePaymentExceptionRefundStatus.PROVIDER_PENDING,
          EcommercePaymentExceptionRefundStatus.FAILED,
        ],
      },
    })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean(),
    EcommercePaymentAttempt.find({
      tenantId,
      operationalStatus: "STUCK_RECONCILE",
    })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean(),
    EcommercePaymentAttempt.find({
      tenantId,
      operationalStatus: "INITIATION_UNCERTAIN",
    })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean(),
    EcommerceOrder.find({
      tenantId,
      paymentExceptionStatus: EcommerceOrderPaymentExceptionStatus.LATE_SUCCESS_REFUND_REQUIRED,
    })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean(),
  ]);

  const items = [];
  for (const row of refundRows) {
    items.push({
      kind: "EXCEPTION_REFUND",
      orderId: row.orderId,
      refundCaseId: row._id,
      status: row.status,
      amountPaise: row.amountPaise,
      currency: row.currency ?? "INR",
      providerRefundId: row.providerRefundId ?? null,
      merchantOrderId: row.merchantOrderId ?? null,
      failureReason: row.failureReason ?? null,
      updatedAt: row.updatedAt ?? null,
    });
  }
  for (const row of stuckAttempts) {
    items.push({
      kind: "STUCK_RECONCILE",
      orderId: row.orderId,
      paymentAttemptId: row._id,
      status: row.status,
      operationalStatus: row.operationalStatus,
      amountPaise: row.amountPaise,
      merchantOrderId: row.merchantOrderId ?? row._id,
      providerOrderId: row.providerOrderId ?? null,
      gatewayReconcileAttempts: row.gatewayReconcileAttempts ?? 0,
      updatedAt: row.updatedAt ?? null,
    });
  }
  for (const row of uncertainAttempts) {
    items.push({
      kind: "INITIATION_UNCERTAIN",
      orderId: row.orderId,
      paymentAttemptId: row._id,
      status: row.status,
      operationalStatus: row.operationalStatus,
      amountPaise: row.amountPaise,
      merchantOrderId: row.merchantOrderId ?? row._id,
      failureReason: row.failureReason ?? null,
      updatedAt: row.updatedAt ?? null,
    });
  }
  for (const row of exceptionOrders) {
    const already = items.some((i) => i.orderId === row._id && i.kind === "EXCEPTION_REFUND");
    if (!already) {
      items.push({
        kind: "LATE_SUCCESS_REFUND_REQUIRED",
        orderId: row._id,
        orderStatus: row.status,
        paymentExceptionStatus: row.paymentExceptionStatus,
        amountPaise: row.totalPaise,
        updatedAt: row.updatedAt ?? null,
      });
    }
  }

  items.sort((a, b) => {
    const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return tb - ta;
  });

  return { items: items.slice(0, limit) };
}
