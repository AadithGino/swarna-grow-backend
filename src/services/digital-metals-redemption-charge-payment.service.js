import { AppError, errors } from "../lib/app-error.js";
import { isEcommercePaymentsTestHarnessEnabled } from "../lib/ecommerce-test-harness.js";
import { createId } from "../lib/ids.js";
import { withTransaction } from "../lib/transaction.js";
import { resolvePhonePeCredentials } from "../integrations/phonepe.provider.js";
import {
  initiateDigitalMetalsPhonePeCheckout,
  isMockDigitalMetalsPaymentAttempt,
  mapCheckoutFieldsForPaymentIntent,
} from "../lib/digital-metals-checkout-init.js";
import {
  mapPhonePeCustomerCheckoutResponse,
  mergePhonePeProviderInitPayload,
  PhonePePersistedCheckoutChannel,
  readPersistedPhonePeCheckoutRedirectUrl,
} from "../lib/phonepe-customer-web-checkout.js";
import { tenantForEcommerceCheckout } from "../lib/ecommerce-checkout-tenant.js";
import { hashIdempotencyBody } from "./idempotency.service.js";
import {
  DigitalMetalRedemptionOrder,
  DigitalMetalRedemptionPaymentAttempt,
} from "../models/index.js";
import {
  finalizeDigitalMetalRedemptionChargeSuccess,
  mapRedemptionOrderPaymentDto,
} from "./digital-metals-redemption-charge-finalize.service.js";
import { assertRedirectUrlAllowed } from "./payment.service.js";

function assertHarness() {
  if (!isEcommercePaymentsTestHarnessEnabled()) throw errors.notFound("Route");
}

function demoRedemptionCheckoutProviderResult(attempt) {
  const merchantOrderId = attempt.merchantOrderId ?? attempt._id;
  return {
    providerOrderId: `mock_${merchantOrderId}`,
    token: `mock-token-${merchantOrderId}`,
    status: "PENDING",
  };
}

const isMockProviderRedemptionPaymentAttempt = isMockDigitalMetalsPaymentAttempt;

function mapRedemptionPaymentIntent(attempt, order, phonePeEnvironment) {
  return {
    id: attempt._id,
    orderId: order._id,
    status: attempt.status,
    amountPaise: attempt.amountPaise,
    currency: "INR",
    merchantOrderId: attempt.merchantOrderId ?? attempt._id,
    redirectUrl: attempt.redirectUrl ?? null,
    statusPollUrl: `/app/digital-metals/redemption/orders/${order._id}/payment-intents/${attempt._id}`,
    failureReason: attempt.failureReason ?? null,
    ...mapPhonePeCustomerCheckoutResponse(attempt, phonePeEnvironment),
    ...mapCheckoutFieldsForPaymentIntent(attempt),
  };
}

export async function maybeCompleteMockRedemptionChargePayment({ tenantId, attempt, order }) {
  if (!isMockProviderRedemptionPaymentAttempt(attempt)) {
    return { attempt, order };
  }
  if (attempt.status === "SUCCEEDED" || order.status === "CHARGE_PAID") {
    const freshOrder = await DigitalMetalRedemptionOrder.findById(order._id).lean();
    const freshAttempt = await DigitalMetalRedemptionPaymentAttempt.findById(attempt._id).lean();
    return { attempt: freshAttempt ?? attempt, order: freshOrder ?? order };
  }
  await finalizeDigitalMetalRedemptionChargeSuccess({
    tenantId,
    merchantOrderId: attempt._id,
    transactionId: `mock-ok-${attempt._id}`,
    amountPaise: attempt.amountPaise,
    source: "MOCK_POLL",
  });
  const freshOrder = await DigitalMetalRedemptionOrder.findById(order._id).lean();
  const freshAttempt = await DigitalMetalRedemptionPaymentAttempt.findById(attempt._id).lean();
  return {
    attempt: freshAttempt ?? attempt,
    order: freshOrder ?? order,
  };
}

export async function initiateRedemptionChargePayment(req) {
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
  }
  hashIdempotencyBody(req.body);
  const redirectUrl = String(req.body.redirectUrl ?? "").trim();
  if (!redirectUrl) {
    throw errors.validation([{ field: "redirectUrl", message: "redirectUrl is required." }]);
  }
  const orderId = req.params.orderId;

  const result = await withTransaction(async (session) => {
    const existing = await DigitalMetalRedemptionPaymentAttempt.findOne({
      tenantId: req.auth.tenantId,
      idempotencyKey,
    }).session(session);
    if (existing) {
      if (
        String(existing.customerId) !== String(req.auth.id)
        || String(existing.orderId) !== String(orderId)
      ) {
        throw errors.notFound("Order");
      }
      if (["FAILED", "SUCCEEDED"].includes(existing.status)) {
        throw errors.business(
          "PAYMENT_ATTEMPT_TERMINAL",
          "This idempotency key belongs to a finished payment attempt. Retry with a new session.",
          { paymentAttemptId: existing._id, status: existing.status },
        );
      }
      const order = await DigitalMetalRedemptionOrder.findById(existing.orderId).session(session).lean();
      return { replay: true, attempt: existing.toObject(), order };
    }
    const order = await DigitalMetalRedemptionOrder.findOne({
      _id: orderId,
      tenantId: req.auth.tenantId,
      customerId: req.auth.id,
    }).session(session);
    if (!order) throw errors.notFound("Order");
    if (order.status === "CHARGE_PAID") {
      throw errors.business("ORDER_ALREADY_PAID", "Charges are already paid.");
    }
    if (order.status !== "CHARGE_PENDING") {
      throw new AppError("ORDER_NOT_PAYABLE", "Order is not awaiting charge payment.", 409);
    }
    if (order.chargeTotalPaise <= 0) {
      throw new AppError("ZERO_CHARGE", "Use zero-charge path; no payment required.", 409);
    }
    if (new Date(order.chargePaymentExpiresAt).getTime() < Date.now()) {
      throw new AppError("QUOTE_EXPIRED", "Charge payment window expired.", 409);
    }
    const active = await DigitalMetalRedemptionPaymentAttempt.findOne({
      tenantId: req.auth.tenantId,
      orderId: order._id,
      status: { $in: ["PENDING", "INITIATED"] },
    }).session(session);
    if (active && active.idempotencyKey !== idempotencyKey) {
      await DigitalMetalRedemptionPaymentAttempt.updateOne(
        { _id: active._id, status: { $in: ["PENDING", "INITIATED"] } },
        {
          $set: { status: "FAILED", failureReason: "SUPERSEDED_BY_RETRY" },
          $inc: { version: 1 },
        },
        { session },
      );
    }
    // Serialize provider initiation against unattended expiry on the order itself.
    const claimed = await DigitalMetalRedemptionOrder.updateOne({ _id: order._id, tenantId: req.auth.tenantId, status: "CHARGE_PENDING", version: order.version }, { $inc: { version: 1 } }, { session });
    if (claimed.modifiedCount !== 1) throw errors.conflict("STATE_RACE", "Redemption changed; refresh and retry.");
    const attemptId = createId("dmrpay");
    const attempt = (
      await DigitalMetalRedemptionPaymentAttempt.create(
        [
          {
            _id: attemptId,
            tenantId: req.auth.tenantId,
            orderId: order._id,
            customerId: req.auth.id,
            amountPaise: order.chargeTotalPaise,
            merchantOrderId: attemptId,
            idempotencyKey,
            status: "PENDING",
            redirectUrl,
          },
        ],
        { session },
      )
    )[0];
    return { replay: false, attempt: attempt.toObject(), order: order.toObject() };
  });

  const tenant = await tenantForEcommerceCheckout(req.auth.tenantId);
  assertRedirectUrlAllowed(redirectUrl, tenant);
  const credentials = resolvePhonePeCredentials(tenant);
  const phonePeEnvironment = credentials?.environment ?? undefined;
  const clientPlatform = String(req.headers["x-platform"] ?? "").trim();
  const attempt = result.attempt;

  const persistedCheckoutUrl = readPersistedPhonePeCheckoutRedirectUrl(attempt);
  if (["FAILED", "SUCCEEDED"].includes(attempt.status)) {
    throw errors.business(
      "PAYMENT_ATTEMPT_TERMINAL",
      "This payment session has ended. Retry to start a new checkout.",
      { paymentAttemptId: attempt._id, status: attempt.status },
    );
  }
  if (
    result.replay
    && attempt.status === "INITIATED"
    && attempt.providerOrderId
    && attempt.checkoutMode
    && persistedCheckoutUrl
    && result.order.status === "CHARGE_PENDING"
  ) {
    return {
      paymentIntent: mapRedemptionPaymentIntent(attempt, result.order, phonePeEnvironment),
      order: mapRedemptionOrderPaymentDto(result.order, [attempt]),
      replay: true,
    };
  }

  try {
    const { provider, checkoutMode } = await initiateDigitalMetalsPhonePeCheckout({
      merchantOrderId: attempt.merchantOrderId ?? attempt._id,
      amountPaise: attempt.amountPaise,
      redirectUrl: attempt.redirectUrl ?? redirectUrl,
      credentials,
      tenantId: req.auth.tenantId,
      demoProviderResult: demoRedemptionCheckoutProviderResult,
      attempt,
      clientPlatform,
    });
    await DigitalMetalRedemptionPaymentAttempt.updateOne(
      { _id: attempt._id, status: { $in: ["PENDING", "INITIATED"] } },
      {
        $set: {
          status: "INITIATED",
          sdkToken:
            provider.phonePeCheckoutChannel === PhonePePersistedCheckoutChannel.SDK_ORDER
              ? provider.token ?? null
              : null,
          redirectUrl: attempt.redirectUrl ?? redirectUrl,
          providerOrderId: provider.providerOrderId ?? provider.orderId ?? null,
          merchantOrderId: provider.merchantOrderId ?? attempt.merchantOrderId ?? attempt._id,
          providerPayload: mergePhonePeProviderInitPayload(attempt.providerPayload, {
            checkoutChannel:
              provider.phonePeCheckoutChannel ?? PhonePePersistedCheckoutChannel.SDK_ORDER,
            provider,
          }),
          checkoutMode,
        },
      },
    );
    const fresh = await DigitalMetalRedemptionPaymentAttempt.findById(attempt._id).lean();
    const mergedAttempt = fresh ?? { ...attempt, ...provider, status: "INITIATED" };
    return {
      paymentIntent: mapRedemptionPaymentIntent(mergedAttempt, result.order),
      order: mapRedemptionOrderPaymentDto(
        await DigitalMetalRedemptionOrder.findById(result.order._id).lean(),
        [mergedAttempt],
      ),
      replay: result.replay,
    };
  } catch (error) {
    await DigitalMetalRedemptionPaymentAttempt.updateOne(
      { _id: attempt._id },
      { $set: { failureReason: "PROVIDER_INITIATION_UNCERTAIN", gatewayReconcileNextAt: new Date() } },
    );
    if (error instanceof AppError) throw error;
    throw errors.business(
      "PAYMENT_INITIATION_UNCERTAIN",
      "Payment may have started at the provider. Poll status or wait for reconciliation.",
      { paymentAttemptId: attempt._id },
    );
  }
}

export async function completeRedemptionChargeTestHarnessPayment(req) {
  assertHarness();
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Required." }]);
  }
  const orderId = req.params.orderId;
  const outcome = String(req.body.outcome ?? "COMPLETED").toUpperCase();
  const order = await DigitalMetalRedemptionOrder.findOne({
    _id: orderId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  if (!order) throw errors.notFound("Order");
  let attempt = await DigitalMetalRedemptionPaymentAttempt.findOne({
    tenantId: req.auth.tenantId,
    orderId,
    idempotencyKey,
  }).lean();
  if (!attempt) {
    attempt = (
      await DigitalMetalRedemptionPaymentAttempt.create({
        _id: createId("dmrpay"),
        tenantId: req.auth.tenantId,
        orderId,
        customerId: req.auth.id,
        amountPaise: order.chargeTotalPaise,
        merchantOrderId: createId("dmrpay"),
        idempotencyKey,
        status: "INITIATED",
      })
    ).toObject();
  }
  if (outcome.includes("FAIL")) {
    await DigitalMetalRedemptionPaymentAttempt.updateOne(
      { _id: attempt._id },
      { $set: { status: "FAILED", failureReason: "TEST_HARNESS" } },
    );
    return mapRedemptionOrderPaymentDto(order, [{ ...attempt, status: "FAILED" }]);
  }
  const fin = await finalizeDigitalMetalRedemptionChargeSuccess({
    tenantId: req.auth.tenantId,
    merchantOrderId: attempt._id,
    transactionId: `test-${attempt._id}`,
    amountPaise: attempt.amountPaise,
    source: "TEST_HARNESS",
  });
  const fresh = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  const attempts = await DigitalMetalRedemptionPaymentAttempt.find({ orderId }).lean();
  return { ...mapRedemptionOrderPaymentDto(fresh, attempts), finalizeOutcome: fin.outcome };
}

export async function pollRedemptionChargePayment(req) {
  let order = await DigitalMetalRedemptionOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  if (!order) throw errors.notFound("Order");
  let attempt = await DigitalMetalRedemptionPaymentAttempt.findOne({
    _id: req.params.paymentAttemptId,
    tenantId: req.auth.tenantId,
    orderId: req.params.orderId,
    customerId: req.auth.id,
  }).lean();
  if (!attempt) throw errors.notFound("Payment attempt");

  const mockCompleted = await maybeCompleteMockRedemptionChargePayment({
    tenantId: req.auth.tenantId,
    attempt,
    order,
  });
  attempt = mockCompleted.attempt;
  order = mockCompleted.order;

  if (attempt.status === "INITIATED" && attempt.providerOrderId && !isMockProviderRedemptionPaymentAttempt(attempt)) {
    const { reconcileRedemptionChargePaymentAttempt } = await import(
      "./digital-metals-redemption-charge-reconcile.service.js"
    );
    await reconcileRedemptionChargePaymentAttempt(attempt, { at: new Date(), leaseOwner: null });
    attempt = await DigitalMetalRedemptionPaymentAttempt.findById(attempt._id).lean();
  }
  const freshOrder = await DigitalMetalRedemptionOrder.findById(req.params.orderId).lean();
  const attempts = await DigitalMetalRedemptionPaymentAttempt.find({ orderId: req.params.orderId }).lean();
  return {
    paymentIntent: mapRedemptionPaymentIntent(attempt, freshOrder ?? order),
    order: mapRedemptionOrderPaymentDto(freshOrder ?? order, attempts),
  };
}
