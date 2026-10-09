import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { assertEcommerceOperational } from "../lib/ecommerce-access.js";
import {
  assertCustomerPaymentAllowed,
  deriveEcommerceCheckoutCapability,
} from "../lib/ecommerce-checkout-capability.js";
import { findActivePaymentAttempt } from "../lib/ecommerce-payment-in-flight.js";
import { assertOrderPaymentBoundary } from "../lib/ecommerce-order-payment-boundary.js";
import { EcommercePaymentAttemptOperationalStatus } from "../constants/enums.js";
import { hashIdempotencyBody } from "./idempotency.service.js";
import { phonePeProvider, resolvePhonePeCredentials } from "../integrations/phonepe.provider.js";
import {
  EcommerceFulfilmentSettings,
  EcommerceOrder,
  EcommerceOrderEvent,
  EcommercePaymentAttempt,
  EcommerceTaxSettings,
  Tenant,
} from "../models/index.js";
import {
  EcommerceOrderEventType,
  EcommerceOrderStatus,
  EcommercePaymentAttemptStatus,
} from "../constants/enums.js";

export function mapPaymentIntent(row, order) {
  const orderId = row.orderId ?? order?.id ?? order?._id;
  return {
    id: row._id,
    orderId,
    status: row.status,
    amountPaise: row.amountPaise,
    currency: row.currency ?? "INR",
    providerOrderId: row.providerOrderId ?? null,
    merchantOrderId: row.merchantOrderId ?? row._id,
    token: row.sdkToken ?? null,
    redirectUrl: row.redirectUrl ?? null,
    orderStatus: order?.status ?? null,
    paymentAllowed: true,
    paymentCompleted: order?.status === EcommerceOrderStatus.PAID,
    statusPollUrl: orderId ? `/app/shop/orders/${orderId}/payment-intents/${row._id}` : null,
    failureReason: row.failureReason ?? null,
    operationalStatus: row.operationalStatus ?? null,
    createdAt: row.createdAt ?? null,
    idempotencyKey: row.idempotencyKey ?? null,
  };
}

export function mapCustomerActivePaymentAttempt(row) {
  if (!row) return null;
  return {
    id: row._id,
    status: row.status,
    amountPaise: row.amountPaise,
    currency: row.currency ?? "INR",
    merchantOrderId: row.merchantOrderId ?? row._id,
    token: row.sdkToken ?? null,
    redirectUrl: row.redirectUrl ?? null,
    failureReason: row.failureReason ?? null,
    operationalStatus: row.operationalStatus ?? null,
    idempotencyKey: row.idempotencyKey ?? null,
  };
}

async function loadPaymentCapability(tenantId, tenantLite) {
  const tenant =
    tenantLite?.integrationSecrets != null
      ? tenantLite
      : await Tenant.findById(tenantId).select("+integrationSecrets").lean();
  const fulfilmentRow = await EcommerceFulfilmentSettings.findOne({ tenantId }).lean();
  const taxSettings = await EcommerceTaxSettings.findOne({ tenantId }).lean();
  return deriveEcommerceCheckoutCapability({
    taxSettings,
    fulfilmentSettingsRow: fulfilmentRow ?? {},
    tenant: tenant ?? tenantLite,
  });
}

async function initiateProviderForAttempt(attempt, order, redirectUrl, tenantId, created) {
  if (
    attempt.status === EcommercePaymentAttemptStatus.INITIATED
    && attempt.sdkToken
    && attempt.providerOrderId
  ) {
    return { paymentIntent: mapPaymentIntent(attempt, order), created: false };
  }

  const claimMarker = `CLAIM-${createId("claim")}`;
  const claimExpiresAt = new Date(Date.now() + 5 * 60_000);
  const claimed = await EcommercePaymentAttempt.findOneAndUpdate(
    {
      _id: attempt._id,
      tenantId,
      status: { $in: [EcommercePaymentAttemptStatus.PENDING, EcommercePaymentAttemptStatus.INITIATED] },
      sdkToken: { $in: [null, ""] },
      $or: [
        { initiationClaimToken: null },
        { initiationClaimToken: { $exists: false } },
        { initiationClaimExpiresAt: { $lte: new Date() } },
      ],
    },
    {
      $set: {
        initiationClaimToken: claimMarker,
        initiationClaimExpiresAt: claimExpiresAt,
      },
    },
    { new: true },
  );

  if (!claimed) {
    let fresh = await EcommercePaymentAttempt.findById(attempt._id).lean();
    for (let i = 0; i < 25; i += 1) {
      if (fresh?.sdkToken && fresh?.providerOrderId) {
        return { paymentIntent: mapPaymentIntent(fresh, order), created: false };
      }
      const claimActive =
        fresh?.initiationClaimToken
        && fresh.initiationClaimExpiresAt
        && new Date(fresh.initiationClaimExpiresAt) > new Date();
      if (!claimActive) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 40);
      });
      fresh = await EcommercePaymentAttempt.findById(attempt._id).lean();
    }
    if (fresh?.sdkToken && fresh?.providerOrderId) {
      return { paymentIntent: mapPaymentIntent(fresh, order), created: false };
    }
    if (
      fresh?.initiationClaimToken
      && fresh.initiationClaimExpiresAt
      && new Date(fresh.initiationClaimExpiresAt) > new Date()
    ) {
      throw errors.business(
        "PAYMENT_INITIATION_IN_PROGRESS",
        "Payment initiation is already in progress for this attempt.",
        { paymentAttemptId: attempt._id },
      );
    }
    throw errors.business(
      "PAYMENT_INITIATION_UNAVAILABLE",
      "Payment attempt cannot be initiated in its current state.",
      { paymentAttemptId: attempt._id, status: fresh?.status },
    );
  }

  const tenant = await Tenant.findById(tenantId).select("+integrationSecrets").lean();
  const credentials = resolvePhonePeCredentials(tenant);
  try {
    const provider = await phonePeProvider.createSdkOrder({
      merchantOrderId: claimed.merchantOrderId ?? claimed._id,
      amountPaise: claimed.amountPaise,
      redirectUrl: claimed.redirectUrl ?? redirectUrl,
      credentials,
      tenantId,
    });
    await EcommercePaymentAttempt.updateOne(
      {
        _id: claimed._id,
        initiationClaimToken: claimMarker,
        status: {
          $in: [EcommercePaymentAttemptStatus.PENDING, EcommercePaymentAttemptStatus.INITIATED],
        },
      },
      {
        $set: {
          status: EcommercePaymentAttemptStatus.INITIATED,
          providerOrderId: provider.providerOrderId,
          sdkToken: provider.token,
          providerInitConfirmedAt: new Date(),
          operationalStatus: EcommercePaymentAttemptOperationalStatus.AWAITING_PROVIDER,
          gatewayReconcileNextAt: new Date(Date.now() + 60_000),
        },
        $unset: { initiationClaimToken: "", initiationClaimExpiresAt: "" },
        $inc: { version: 1 },
      },
    );
    const fresh = await EcommercePaymentAttempt.findById(claimed._id).lean();
    return {
      paymentIntent: mapPaymentIntent(
        fresh ?? {
          ...(typeof claimed.toObject === "function" ? claimed.toObject() : claimed),
          ...provider,
          status: EcommercePaymentAttemptStatus.INITIATED,
        },
        order,
      ),
      created,
    };
  } catch (error) {
    await EcommercePaymentAttempt.updateOne(
      { _id: claimed._id, initiationClaimToken: claimMarker },
      {
        $set: {
          operationalStatus: EcommercePaymentAttemptOperationalStatus.INITIATION_UNCERTAIN,
          failureReason: "PROVIDER_INITIATION_UNCERTAIN",
          gatewayReconcileNextAt: new Date(),
        },
        $unset: { initiationClaimToken: "", initiationClaimExpiresAt: "" },
        $inc: { version: 1 },
      },
    );
    if (error instanceof AppError) throw error;
    throw errors.business(
      "PAYMENT_INITIATION_UNCERTAIN",
      "Payment may have started at the provider. Poll status or wait for reconciliation.",
      { paymentAttemptId: claimed._id },
    );
  }
}

export async function createEcommercePaymentIntent(req) {
  assertEcommerceOperational(req.tenant);
  const capability = await loadPaymentCapability(req.auth.tenantId, req.tenant);
  assertCustomerPaymentAllowed(capability);

  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
  }
  const bodyHash = hashIdempotencyBody(req.body);
  const redirectUrl = String(req.body.redirectUrl ?? "").trim();
  if (!redirectUrl) {
    throw errors.validation([{ field: "redirectUrl", message: "redirectUrl is required." }]);
  }

  const orderId = req.params.orderId;
  let reserved;
  try {
    reserved = await withTransaction(async (session) => {
      const existingByKey = await EcommercePaymentAttempt.findOne({
        tenantId: req.auth.tenantId,
        idempotencyKey,
      }).session(session);
      if (existingByKey) {
        if (existingByKey.orderId !== orderId || existingByKey.customerId !== req.auth.id) {
          throw errors.conflict(
            "IDEMPOTENCY_KEY_REUSED",
            "This idempotency key was already used with a different request.",
          );
        }
        if (existingByKey.creationBodyHash && existingByKey.creationBodyHash !== bodyHash) {
          throw errors.conflict(
            "IDEMPOTENCY_KEY_REUSED",
            "This idempotency key was already used with a different request.",
          );
        }
        const order = await EcommerceOrder.findOne({
          _id: existingByKey.orderId,
          tenantId: req.auth.tenantId,
          customerId: req.auth.id,
        }).session(session);
        if (!order) throw errors.notFound("Order");
        return { kind: "REPLAY", attempt: existingByKey.toObject(), order: order.toObject() };
      }

      const order = await EcommerceOrder.findOne({
        _id: orderId,
        tenantId: req.auth.tenantId,
        customerId: req.auth.id,
      }).session(session);
      if (!order) throw errors.notFound("Order");
      if (order.status === EcommerceOrderStatus.PAID) {
        throw errors.business("ORDER_ALREADY_PAID", "Order is already paid.");
      }
      if (order.status !== EcommerceOrderStatus.PENDING_PAYMENT) {
        throw errors.business("ORDER_NOT_PAYABLE", "Order is not awaiting payment.", {
          status: order.status,
        });
      }
      const boundary = await assertOrderPaymentBoundary({
        orderRow: order.toObject(),
        tenant: req.tenant,
        customerId: req.auth.id,
        session,
      });
      if (!boundary.ok) {
        throw new AppError(
          boundary.code ?? "ORDER_NOT_PAYABLE",
          "Order cannot be paid in its current state.",
          422,
          boundary,
        );
      }

      const active = await findActivePaymentAttempt(req.auth.tenantId, order._id, session);
      if (active && active.idempotencyKey !== idempotencyKey) {
        throw errors.business("PAYMENT_ATTEMPT_IN_PROGRESS", "A payment attempt is already in progress.", {
          paymentAttemptId: active._id,
          activePaymentAttempt: mapCustomerActivePaymentAttempt(active),
        });
      }
      if (active?.idempotencyKey === idempotencyKey) {
        return { kind: "REPLAY", attempt: active, order: order.toObject() };
      }

      const attemptId = createId("epay");
      const attempt = (
        await EcommercePaymentAttempt.create(
          [
            {
              _id: attemptId,
              tenantId: req.auth.tenantId,
              orderId: order._id,
              customerId: req.auth.id,
              status: EcommercePaymentAttemptStatus.PENDING,
              amountPaise: order.totalPaise,
              currency: "INR",
              provider: "PHONEPE",
              merchantOrderId: attemptId,
              idempotencyKey,
              creationBodyHash: bodyHash,
              redirectUrl,
              expiresAt: order.expiresAt,
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
            type: EcommerceOrderEventType.PAYMENT_INITIATED,
            actorType: "CUSTOMER",
            actorId: req.auth.id,
            payload: { paymentAttemptId: attempt._id },
          },
        ],
        { session },
      );

      return {
        kind: "NEW",
        attempt: attempt.toObject(),
        order: order.toObject(),
      };
    });
  } catch (err) {
    if (err?.code === 11000) {
      const row = await EcommercePaymentAttempt.findOne({
        tenantId: req.auth.tenantId,
        idempotencyKey,
      }).lean();
      if (row) {
        if (row.orderId !== orderId || row.customerId !== req.auth.id) {
          throw errors.conflict(
            "IDEMPOTENCY_KEY_REUSED",
            "This idempotency key was already used with a different request.",
          );
        }
        const order = await EcommerceOrder.findOne({
          _id: row.orderId,
          tenantId: req.auth.tenantId,
          customerId: req.auth.id,
        }).lean();
        if (order) {
          reserved = { kind: "REPLAY", attempt: row, order };
        }
      } else throw err;
    } else throw err;
  }

  return initiateProviderForAttempt(
    reserved.attempt,
    reserved.order,
    redirectUrl,
    req.auth.tenantId,
    reserved.kind === "NEW",
  );
}

export async function getEcommercePaymentIntent(req) {
  assertEcommerceOperational(req.tenant);
  const row = await EcommercePaymentAttempt.findOne({
    _id: req.params.paymentAttemptId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  if (!row) throw errors.notFound("Payment attempt");
  const order = await EcommerceOrder.findOne({
    _id: row.orderId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  return mapPaymentIntent(row, order);
}

export async function listAdminOrderPaymentAttempts(req) {
  const order = await EcommerceOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!order) throw errors.notFound("Order");
  const items = await EcommercePaymentAttempt.find({
    tenantId: req.auth.tenantId,
    orderId: order._id,
  })
    .sort({ createdAt: -1 })
    .lean();
  return { items };
}

export async function listAdminOrderPaymentAttemptEvents(req) {
  const order = await EcommerceOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!order) throw errors.notFound("Order");
  const { EcommercePaymentAttemptEvent } = await import("../models/index.js");
  const attemptId = req.query.paymentAttemptId;
  const filter = { tenantId: req.auth.tenantId, orderId: order._id };
  if (attemptId) filter.paymentAttemptId = String(attemptId);
  const items = await EcommercePaymentAttemptEvent.find(filter).sort({ at: -1 }).limit(200).lean();
  return { items };
}
