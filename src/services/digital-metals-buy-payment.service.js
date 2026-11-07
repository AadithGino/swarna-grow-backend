import { CallbackType } from "@phonepe-pg/pg-sdk-node";
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
import { tenantForEcommerceCheckout } from "../lib/ecommerce-checkout-tenant.js";
import { hashIdempotencyBody } from "./idempotency.service.js";
import { DigitalMetalBuyOrder, DigitalMetalBuyPaymentAttempt, WebhookEvent } from "../models/index.js";
import { mapBuyOrderStatusDto } from "./digital-metals-buy-finalize.service.js";
import { processWebhook } from "../workers/processors.js";
import { readCheckoutChannel } from "../lib/phonepe-customer-checkout-init.js";
import {
  mapPhonePeCustomerCheckoutResponse,
  mergePhonePeProviderInitPayload,
  PhonePePersistedCheckoutChannel,
  readPersistedPhonePeCheckoutRedirectUrl,
} from "../lib/phonepe-customer-web-checkout.js";
import { maybeReconcileLiveDigitalMetalBuyAttempt } from "./digital-metals-payment-reconcile.service.js";
import { assertRedirectUrlAllowed } from "./payment.service.js";

function assertBuyPaymentTestHarness() {
  if (!isEcommercePaymentsTestHarnessEnabled()) throw errors.notFound("Route");
}

function demoBuyCheckoutProviderResult(attempt) {
  const merchantOrderId = attempt.merchantOrderId ?? attempt._id;
  return {
    providerOrderId: `mock_${merchantOrderId}`,
    token: `mock-token-${merchantOrderId}`,
    status: "PENDING",
  };
}

async function queueDigitalMetalBuyTestWebhook({ tenantId, type, payload, providerEventId }) {
  const eventId = createId("webhook");
  await WebhookEvent.create({
    _id: eventId,
    tenantId,
    provider: "PHONEPE",
    providerEventId,
    status: "QUEUED",
    payload: { type, payload },
  });
  await processWebhook({ data: { webhookEventId: eventId }, attemptsMade: 0 });
  return eventId;
}

const isMockProviderBuyPaymentAttempt = isMockDigitalMetalsPaymentAttempt;

function isPhonePeCredentialError(error) {
  const type = String(error?.type ?? error?.name ?? "");
  const message = String(error?.message ?? error ?? "").toLowerCase();
  return (
    type === "UnauthorizedAccess"
    || message.includes("unauthorized")
    || message.includes("payment gateway not configured")
  );
}

async function simulateBuyPaymentWebhookOutcome({ tenantId, attempt, order, outcome }) {
  const merchantOrderId = attempt.merchantOrderId ?? attempt._id;
  const amountPaise = order.totalPayablePaise;
  const transactionId = outcome === "FAILED" ? `mock-fail-${attempt._id}` : `mock-ok-${attempt._id}`;
  if (outcome === "FAILED") {
    await queueDigitalMetalBuyTestWebhook({
      tenantId,
      type: "CHECKOUT_ORDER_FAILED",
      providerEventId: `mock-dm-fail-${attempt._id}`,
      payload: {
        originalMerchantOrderId: merchantOrderId,
        amount: amountPaise,
        paymentDetails: [{ state: "FAILED", transactionId, amount: amountPaise }],
      },
    });
    return;
  }
  await queueDigitalMetalBuyTestWebhook({
    tenantId,
    type: CallbackType.CHECKOUT_ORDER_COMPLETED,
    providerEventId: `mock-dm-ok-${attempt._id}`,
    payload: {
      originalMerchantOrderId: merchantOrderId,
      amount: amountPaise,
      currency: "INR",
      paymentDetails: [{ state: "COMPLETED", transactionId, amount: amountPaise }],
    },
  });
}

/** When PhonePe runs in mock provider mode, poll simulates gateway success (demo / local). */
export async function maybeCompleteMockDigitalMetalBuyPayment({ tenantId, attempt, order }) {
  if (!isMockProviderBuyPaymentAttempt(attempt)) {
    return { attempt, order };
  }
  await simulateBuyPaymentWebhookOutcome({
    tenantId,
    attempt,
    order,
    outcome: "COMPLETED",
  });
  const freshOrder = await DigitalMetalBuyOrder.findById(order._id).lean();
  const freshAttempt = await DigitalMetalBuyPaymentAttempt.findById(attempt._id).lean();
  return {
    attempt: freshAttempt ?? attempt,
    order: freshOrder ?? order,
  };
}

function mapPaymentIntent(row, order, phonePeEnvironment) {
  return {
    id: row._id,
    orderId: order._id,
    status: row.status,
    amountPaise: row.amountPaise,
    currency: row.currency ?? "INR",
    merchantOrderId: row.merchantOrderId ?? row._id,
    redirectUrl: row.redirectUrl ?? null,
    statusPollUrl: `/app/digital-metals/buy-orders/${order._id}/payment-intents/${row._id}`,
    failureReason: row.failureReason ?? null,
    ...mapPhonePeCustomerCheckoutResponse(row, phonePeEnvironment),
    ...mapCheckoutFieldsForPaymentIntent(row),
  };
}

export async function initiateDigitalMetalBuyPaymentAttempt(req) {
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
      const existingByKey = await DigitalMetalBuyPaymentAttempt.findOne({
        tenantId: req.auth.tenantId,
        idempotencyKey,
      }).session(session);
      if (existingByKey) {
        if (
          String(existingByKey.orderId) !== String(orderId)
          || String(existingByKey.customerId) !== String(req.auth.id)
        ) {
          throw errors.notFound("Order");
        }
        if (existingByKey.creationBodyHash && existingByKey.creationBodyHash !== bodyHash) {
          throw errors.conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency key reused with different payload.");
        }
        const order = await DigitalMetalBuyOrder.findOne({
          _id: orderId,
          tenantId: req.auth.tenantId,
          customerId: req.auth.id,
        }).session(session);
        if (!order) throw errors.notFound("Order");
        if (["FAILED", "SUCCEEDED"].includes(existingByKey.status)) {
          throw errors.business(
            "PAYMENT_ATTEMPT_TERMINAL",
            "This idempotency key belongs to a finished payment attempt. Retry with a new session.",
            { paymentAttemptId: existingByKey._id, status: existingByKey.status },
          );
        }
        return { kind: "REPLAY", attempt: existingByKey.toObject(), order: order.toObject() };
      }

      const order = await DigitalMetalBuyOrder.findOne({
        _id: orderId,
        tenantId: req.auth.tenantId,
        customerId: req.auth.id,
      }).session(session);
      if (!order) throw errors.notFound("Order");
      if (order.status === "CREDITED") {
        throw errors.business("ORDER_ALREADY_PAID", "Purchase is already credited.");
      }
      if (!["QUOTE_ACCEPTED", "PAYMENT_PENDING", "PAYMENT_FAILED"].includes(order.status)) {
        throw errors.business("ORDER_NOT_PAYABLE", "Order is not payable.", { status: order.status });
      }
      if (new Date(order.paymentAcceptanceExpiresAt).getTime() < Date.now()) {
        await DigitalMetalBuyOrder.updateOne(
          { _id: order._id, status: { $nin: ["CREDITED", "EXPIRED"] } },
          { $set: { status: "EXPIRED" }, $inc: { version: 1 } },
          { session },
        );
        throw new AppError("QUOTE_EXPIRED", "Payment window has expired.", 409);
      }

      const active = await DigitalMetalBuyPaymentAttempt.findOne({
        tenantId: req.auth.tenantId,
        orderId: order._id,
        status: { $in: ["PENDING", "INITIATED"] },
      }).session(session);
      if (active && active.idempotencyKey !== idempotencyKey) {
        // A new idempotency key means the customer started a fresh checkout (retry / continue).
        await DigitalMetalBuyPaymentAttempt.updateOne(
          { _id: active._id, status: { $in: ["PENDING", "INITIATED"] } },
          {
            $set: { status: "FAILED", failureReason: "SUPERSEDED_BY_RETRY" },
            $inc: { version: 1 },
          },
          { session },
        );
      }
      if (active?.idempotencyKey === idempotencyKey) {
        return { kind: "REPLAY", attempt: active.toObject(), order: order.toObject() };
      }

      const attemptId = createId("dmpay");
      const attempt = (
        await DigitalMetalBuyPaymentAttempt.create(
          [
            {
              _id: attemptId,
              tenantId: req.auth.tenantId,
              orderId: order._id,
              customerId: req.auth.id,
              status: "PENDING",
              amountPaise: order.totalPayablePaise,
              currency: "INR",
              provider: "PHONEPE",
              merchantOrderId: attemptId,
              idempotencyKey,
              creationBodyHash: bodyHash,
              redirectUrl,
            },
          ],
          { session },
        )
      )[0];
      await DigitalMetalBuyOrder.updateOne(
        { _id: order._id },
        { $set: { status: "PAYMENT_PENDING" }, $inc: { version: 1 } },
        { session },
      );
      return { kind: "NEW", attempt: attempt.toObject(), order: order.toObject() };
    });
  } catch (err) {
    if (err?.code === 11000) {
      const row = await DigitalMetalBuyPaymentAttempt.findOne({
        tenantId: req.auth.tenantId,
        idempotencyKey,
      }).lean();
      if (
        row
        && String(row.orderId) === String(orderId)
        && String(row.customerId) === String(req.auth.id)
        && (!row.creationBodyHash || row.creationBodyHash === bodyHash)
      ) {
        const order = await DigitalMetalBuyOrder.findById(orderId).lean();
        if (!order || String(order.customerId) !== String(req.auth.id)) {
          throw errors.notFound("Order");
        }
        reserved = { kind: "REPLAY", attempt: row, order };
      } else if (row) {
        throw errors.notFound("Order");
      } else throw err;
    } else throw err;
  }

  const tenant = await tenantForEcommerceCheckout(req.auth.tenantId, req.tenant);
  assertRedirectUrlAllowed(redirectUrl, tenant);
  const credentials = resolvePhonePeCredentials(tenant);
  const phonePeEnvironment = credentials?.environment ?? undefined;
  const clientPlatform = String(req.headers["x-platform"] ?? "").trim();
  const checkoutChannel = readCheckoutChannel(req.headers);
  let attempt = reserved.attempt;
  if (["FAILED", "SUCCEEDED"].includes(attempt.status)) {
    throw errors.business(
      "PAYMENT_ATTEMPT_TERMINAL",
      "This payment session has ended. Retry to start a new checkout.",
      { paymentAttemptId: attempt._id, status: attempt.status },
    );
  }
  const persistedCheckoutUrl = readPersistedPhonePeCheckoutRedirectUrl(attempt);
  if (
    attempt.status === "INITIATED"
    && attempt.providerOrderId
    && attempt.checkoutMode
    && persistedCheckoutUrl
    && reserved.order.status !== "PAYMENT_FAILED"
  ) {
    return {
      paymentIntent: mapPaymentIntent(attempt, reserved.order, phonePeEnvironment),
      order: mapBuyOrderStatusDto(reserved.order, [attempt]),
    };
  }

  if (
    attempt.status === "INITIATED"
    && attempt.sdkToken
    && !persistedCheckoutUrl
    && attempt.providerOrderId
  ) {
    await DigitalMetalBuyPaymentAttempt.updateOne(
      { _id: attempt._id, status: { $in: ["PENDING", "INITIATED"] } },
      {
        $set: { status: "PENDING" },
        $unset: { sdkToken: "", providerOrderId: "" },
        $inc: { version: 1 },
      },
    );
    attempt = {
      ...attempt,
      status: "PENDING",
      sdkToken: null,
      providerOrderId: null,
    };
  }

  if (!attempt.sdkToken && !persistedCheckoutUrl && attempt.failureReason) {
    await DigitalMetalBuyPaymentAttempt.updateOne(
      { _id: attempt._id, status: { $in: ["PENDING", "INITIATED"] } },
      { $unset: { failureReason: "" }, $inc: { version: 1 } },
    );
    attempt = { ...attempt, failureReason: null };
  }

  try {
    const { provider, checkoutMode } = await initiateDigitalMetalsPhonePeCheckout({
      merchantOrderId: attempt.merchantOrderId ?? attempt._id,
      amountPaise: attempt.amountPaise,
      redirectUrl: attempt.redirectUrl ?? redirectUrl,
      credentials,
      tenantId: req.auth.tenantId,
      demoProviderResult: demoBuyCheckoutProviderResult,
      attempt,
      clientPlatform,
      checkoutChannel,
    });
    await DigitalMetalBuyPaymentAttempt.updateOne(
      { _id: attempt._id, status: { $in: ["PENDING", "INITIATED"] } },
      {
        $set: {
          status: "INITIATED",
          providerOrderId: provider.providerOrderId,
          merchantOrderId: provider.merchantOrderId ?? attempt.merchantOrderId ?? attempt._id,
          sdkToken:
            provider.phonePeCheckoutChannel === PhonePePersistedCheckoutChannel.SDK_ORDER
              ? provider.token ?? null
              : null,
          providerPayload: mergePhonePeProviderInitPayload(attempt.providerPayload, {
            checkoutChannel:
              provider.phonePeCheckoutChannel ?? PhonePePersistedCheckoutChannel.SDK_ORDER,
            provider,
          }),
          checkoutMode,
          gatewayReconcileNextAt: new Date(Date.now() + 60_000),
        },
        $inc: { version: 1 },
      },
    );
    const fresh = await DigitalMetalBuyPaymentAttempt.findById(attempt._id).lean();
    return {
      paymentIntent: mapPaymentIntent(
        fresh ?? { ...attempt, ...provider, status: "INITIATED" },
        reserved.order,
        phonePeEnvironment,
      ),
      order: mapBuyOrderStatusDto(
        await DigitalMetalBuyOrder.findById(reserved.order._id).lean(),
        [fresh ?? attempt],
      ),
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (isPhonePeCredentialError(error)) {
      await DigitalMetalBuyPaymentAttempt.updateOne(
        { _id: attempt._id, status: { $in: ["PENDING", "INITIATED"] } },
        {
          $set: { failureReason: "PHONEPE_UNAUTHORIZED" },
          $unset: { sdkToken: "", providerOrderId: "" },
          $inc: { version: 1 },
        },
      );
      throw errors.business(
        "PAYMENT_GATEWAY_UNAUTHORIZED",
        "PhonePe rejected the jeweller credentials. Update payment gateway settings in Platform and retry.",
        { paymentAttemptId: attempt._id },
      );
    }
    await DigitalMetalBuyPaymentAttempt.updateOne(
      { _id: attempt._id },
      {
        $set: {
          failureReason: "PROVIDER_INITIATION_UNCERTAIN",
          gatewayReconcileNextAt: new Date(),
        },
        $inc: { version: 1 },
      },
    );
    throw errors.business(
      "PAYMENT_INITIATION_UNCERTAIN",
      "Payment may have started at the provider. Poll status or wait for reconciliation.",
      { paymentAttemptId: attempt._id },
    );
  }
}

export async function getBuyOrderPaymentIntent(req) {
  const order = await DigitalMetalBuyOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  if (!order) throw errors.notFound("Order");
  const attempt = await DigitalMetalBuyPaymentAttempt.findOne({
    _id: req.params.paymentAttemptId,
    tenantId: req.auth.tenantId,
    orderId: order._id,
  }).lean();
  if (!attempt) throw errors.notFound("Payment attempt");
  let resolvedAttempt;
  let resolvedOrder;
  if (isMockDigitalMetalsPaymentAttempt(attempt)) {
    const mockCompleted = await maybeCompleteMockDigitalMetalBuyPayment({
      tenantId: req.auth.tenantId,
      attempt,
      order,
    });
    resolvedAttempt = mockCompleted.attempt;
    resolvedOrder = mockCompleted.order;
  } else {
    await maybeReconcileLiveDigitalMetalBuyAttempt(attempt, { at: new Date() });
    resolvedAttempt =
      (await DigitalMetalBuyPaymentAttempt.findById(attempt._id).lean()) ?? attempt;
    resolvedOrder =
      (await DigitalMetalBuyOrder.findById(order._id).lean()) ?? order;
  }
  return {
    paymentIntent: mapPaymentIntent(resolvedAttempt, resolvedOrder),
    order: mapBuyOrderStatusDto(resolvedOrder, [resolvedAttempt]),
  };
}

/** Test harness only — simulates PhonePe webhook completion for digital-metal buy orders. */
export async function completeTestHarnessBuyPayment(req) {
  assertBuyPaymentTestHarness();
  const outcome = String(req.body?.outcome ?? "COMPLETED").trim().toUpperCase();
  if (!["COMPLETED", "FAILED"].includes(outcome)) {
    throw errors.validation([{ field: "outcome", message: "Use COMPLETED or FAILED." }]);
  }
  const order = await DigitalMetalBuyOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  if (!order) throw errors.notFound("Order");
  const attemptId = String(req.body?.paymentAttemptId ?? "").trim();
  const attempt = attemptId
    ? await DigitalMetalBuyPaymentAttempt.findOne({
        _id: attemptId,
        tenantId: req.auth.tenantId,
        orderId: order._id,
      }).lean()
    : await DigitalMetalBuyPaymentAttempt.findOne({
        tenantId: req.auth.tenantId,
        orderId: order._id,
        status: { $in: ["INITIATED", "PENDING"] },
      })
        .sort({ createdAt: -1 })
        .lean();
  if (!attempt) {
    throw errors.business("PAYMENT_ATTEMPT_REQUIRED", "Create a payment attempt first.", {});
  }
  await simulateBuyPaymentWebhookOutcome({
    tenantId: req.auth.tenantId,
    attempt,
    order,
    outcome,
  });
  const freshOrder = await DigitalMetalBuyOrder.findById(order._id).lean();
  const freshAttempt = await DigitalMetalBuyPaymentAttempt.findById(attempt._id).lean();
  return {
    outcome,
    orderId: order._id,
    orderStatus: freshOrder?.status ?? null,
    paymentAttemptId: attempt._id,
    paymentAttemptStatus: freshAttempt?.status ?? null,
    testOnly: true,
  };
}
