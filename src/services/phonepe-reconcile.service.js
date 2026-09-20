import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { LateSuccessDetection, PaymentIntentStatus, PaymentMode, PaymentStatus } from "../constants/enums.js";
import { phonePeProvider, resolvePhonePeCredentials } from "../integrations/phonepe.provider.js";
import { validatePhonePeCompletedIdentifiers } from "../lib/phonepe-completed-identifiers.js";
import { PhonePeOrderStatusKind, normalizePhonePeOrderStatus } from "../lib/phonepe-order-status.js";
import { randomToken } from "../lib/crypto.js";
import { Alert, Payment, PaymentIntent, PaymentLink, Tenant } from "../models/index.js";
import { applyTerminalGatewayFailure } from "./gateway-terminal-failure.service.js";
import { recordPhonePeReconcileOutcome } from "../lib/ops-metrics.js";
import {
  reconcileTestHookBeforeExhaustionTransition,
  reconcileTestHookBeforeReconcileCore,
  reconcileTestHookBeforeTerminalFailure,
  reconcileTestHookDuringReconcileProgress,
} from "../lib/phonepe-reconcile-test-hooks.js";
import { finalizeGatewaySuccess, GatewayFinalizeOutcome } from "./finalize-gateway-success.service.js";

function reconcileLeaseMs() {
  return env.PHONEPE_RECONCILE_LEASE_MS ?? 120_000;
}

function staleCutoff() {
  return new Date(Date.now() - (env.PHONEPE_RECONCILE_STALE_SECONDS ?? 900) * 1000);
}

function backoffNextAt(attempts) {
  const baseSec = Math.min(3600, 60 * 2 ** Math.min(attempts, 6));
  const jitterSec = Math.floor(Math.random() * Math.min(30, Math.max(1, baseSec)));
  return new Date(Date.now() + (baseSec + jitterSec) * 1000);
}

export async function resolveMerchantOrderIdForPayment(payment) {
  const intent = await PaymentIntent.findOne({
    tenantId: payment.tenantId,
    paymentId: payment._id,
  })
    .select("_id providerOrderId")
    .lean();
  if (intent) return intent._id;
  const link = await PaymentLink.findOne({
    tenantId: payment.tenantId,
    paymentId: payment._id,
  })
    .select("_id")
    .lean();
  if (link) return link._id;
  const match = payment.receiptNumber?.match(/^PENDING-(.+)$/);
  return match?.[1] ?? null;
}

async function loadIntentAndLink({ tenantId, paymentId, merchantOrderId }) {
  const intent = merchantOrderId
    ? await PaymentIntent.findOne({
      tenantId,
      $or: [{ _id: merchantOrderId }, { paymentId }],
    }).lean()
    : await PaymentIntent.findOne({ tenantId, paymentId }).lean();
  const link = !intent && merchantOrderId
    ? await PaymentLink.findOne({ tenantId, _id: merchantOrderId }).lean()
    : await PaymentLink.findOne({ tenantId, paymentId }).lean();
  return { intent, link };
}

export const loadIntentAndLinkForPayment = loadIntentAndLink;

function buildReconcileLeaseToken(workerLabel, paymentId) {
  return `${workerLabel}_${paymentId}_${randomToken(8)}`;
}

async function establishReconcileExhaustedIfAtThreshold(payment, merchantOrderId) {
  const maxAttempts = env.PHONEPE_RECONCILE_MAX_ATTEMPTS ?? 5;
  const attempts = payment.gatewayReconcileAttempts ?? 0;
  if (attempts < maxAttempts) return null;
  const leaseOwner = payment.gatewayReconcileLeaseOwner ?? null;
  const exhausted = await Payment.findOneAndUpdate(
    {
      _id: payment._id,
      tenantId: payment.tenantId,
      status: PaymentStatus.PENDING,
      gatewayReconcileAttempts: { $gte: maxAttempts },
      reviewReason: { $ne: "GATEWAY_RECONCILE_EXHAUSTED" },
      gatewayLastReconcileOutcome: { $ne: "RECONCILE_EXHAUSTED" },
      ...(leaseOwner ? { gatewayReconcileLeaseOwner: leaseOwner } : {}),
    },
    {
      $set: {
        gatewayReconcileNextAt: null,
        gatewayLastReconcileOutcome: "RECONCILE_EXHAUSTED",
        requiresReview: true,
        reviewReason: "GATEWAY_RECONCILE_EXHAUSTED",
        gatewayLastReconcileAt: new Date(),
      },
    },
    { new: true },
  ).lean();
  if (exhausted) {
    await upsertReconcileExhaustedAlert({
      tenantId: payment.tenantId,
      paymentId: payment._id,
      merchantOrderId,
      attempts: exhausted.gatewayReconcileAttempts ?? attempts,
      detail: "PhonePe order remained pending or incomplete after the configured reconcile attempt limit.",
    });
    recordPhonePeReconcileOutcome("RECONCILE_EXHAUSTED");
    return {
      outcome: "RECONCILE_EXHAUSTED",
      paymentId: payment._id,
      attempts: exhausted.gatewayReconcileAttempts ?? attempts,
    };
  }
  const row = await Payment.findOne({ _id: payment._id, tenantId: payment.tenantId }).lean();
  if (row?.reviewReason === "GATEWAY_RECONCILE_EXHAUSTED"
    || row?.gatewayLastReconcileOutcome === "RECONCILE_EXHAUSTED") {
    return {
      outcome: "RECONCILE_EXHAUSTED",
      paymentId: payment._id,
      attempts: row.gatewayReconcileAttempts,
    };
  }
  return null;
}

async function upsertReconcileExhaustedAlert({ tenantId, paymentId, merchantOrderId, attempts, detail }) {
  await Alert.findOneAndUpdate(
    {
      tenantId,
      type: "GATEWAY_RECONCILE_EXHAUSTED",
      entityId: paymentId,
      status: "OPEN",
    },
    {
      $setOnInsert: {
        severity: "CRITICAL",
        title: "Gateway reconciliation exhausted",
        message: detail,
        entityType: "PAYMENT",
        metadata: { merchantOrderId, attempts },
      },
    },
    { upsert: true },
  );
}

function progressFollowUpFence({ paymentId, tenantId, attempts, leaseOwner }) {
  return {
    _id: paymentId,
    tenantId,
    status: PaymentStatus.PENDING,
    gatewayReconcileAttempts: attempts,
    reviewReason: { $ne: "GATEWAY_RECONCILE_EXHAUSTED" },
    gatewayLastReconcileOutcome: { $ne: "RECONCILE_EXHAUSTED" },
    ...(leaseOwner ? { gatewayReconcileLeaseOwner: leaseOwner } : {}),
  };
}

async function outcomeWhenFencedLeaseRefetchMisses(paymentId, tenantId, expectedLeaseOwner) {
  const diag = await Payment.findOne({ _id: paymentId, tenantId }).lean();
  if (!diag) return { outcome: "NOT_PENDING" };
  if (diag.reviewReason === "GATEWAY_RECONCILE_EXHAUSTED"
    || diag.gatewayLastReconcileOutcome === "RECONCILE_EXHAUSTED") {
    return {
      outcome: "RECONCILE_EXHAUSTED",
      paymentId: diag._id,
      attempts: diag.gatewayReconcileAttempts,
    };
  }
  if (diag.status !== PaymentStatus.PENDING) {
    return {
      outcome: "NOT_PENDING",
      paymentId: diag._id,
      attempts: diag.gatewayReconcileAttempts,
    };
  }
  if (diag.gatewayReconcileLeaseOwner !== expectedLeaseOwner) {
    recordPhonePeReconcileOutcome("LEASE_LOST");
    return {
      outcome: "LEASE_LOST",
      paymentId: diag._id,
      attempts: diag.gatewayReconcileAttempts,
    };
  }
  recordPhonePeReconcileOutcome("LEASE_LOST");
  return {
    outcome: "LEASE_LOST",
    paymentId: diag._id,
    attempts: diag.gatewayReconcileAttempts,
  };
}

async function refetchPaymentForReconcileCore(payment, expectedLeaseOwner) {
  if (expectedLeaseOwner) {
    const fenced = await Payment.findOne({
      _id: payment._id,
      tenantId: payment.tenantId,
      gatewayReconcileLeaseOwner: expectedLeaseOwner,
    }).lean();
    if (fenced) return { payment: fenced, earlyOutcome: null };
    const earlyOutcome = await outcomeWhenFencedLeaseRefetchMisses(
      payment._id,
      payment.tenantId,
      expectedLeaseOwner,
    );
    return { payment: null, earlyOutcome };
  }
  const current = await Payment.findOne({
    _id: payment._id,
    tenantId: payment.tenantId,
  }).lean();
  if (!current) return { payment: null, earlyOutcome: { outcome: "NOT_PENDING" } };
  return { payment: current, earlyOutcome: null };
}

async function resolveProgressOutcomeFromRow(paymentId, tenantId, leaseOwner, progressOutcome, providerState) {
  const row = await Payment.findOne({ _id: paymentId, tenantId }).lean();
  if (!row) return { outcome: "NOT_PENDING", progressOutcome, providerState };
  if (row.reviewReason === "GATEWAY_RECONCILE_EXHAUSTED"
    || row.gatewayLastReconcileOutcome === "RECONCILE_EXHAUSTED") {
    return {
      outcome: "RECONCILE_EXHAUSTED",
      progressOutcome,
      providerState,
      attempts: row.gatewayReconcileAttempts,
    };
  }
  if (leaseOwner && row.gatewayReconcileLeaseOwner !== leaseOwner) {
    return {
      outcome: "LEASE_LOST",
      progressOutcome,
      providerState,
      attempts: row.gatewayReconcileAttempts,
    };
  }
  if (row.status !== PaymentStatus.PENDING) {
    return { outcome: "NOT_PENDING", progressOutcome, providerState, attempts: row.gatewayReconcileAttempts };
  }
  return {
    outcome: row.gatewayLastReconcileOutcome ?? progressOutcome,
    progressOutcome,
    providerState,
    attempts: row.gatewayReconcileAttempts,
  };
}

async function recordNonTerminalReconcileProgress(paymentId, tenantId, merchantOrderId, {
  progressOutcome,
  errorMessage = null,
  providerState = null,
  leaseOwner = null,
}) {
  await reconcileTestHookDuringReconcileProgress();

  const maxAttempts = env.PHONEPE_RECONCILE_MAX_ATTEMPTS ?? 5;
  const now = new Date();
  const incrementFilter = {
    _id: paymentId,
    tenantId,
    status: PaymentStatus.PENDING,
    reviewReason: { $ne: "GATEWAY_RECONCILE_EXHAUSTED" },
    gatewayLastReconcileOutcome: { $ne: "RECONCILE_EXHAUSTED" },
    ...(leaseOwner ? { gatewayReconcileLeaseOwner: leaseOwner } : {}),
  };

  const updated = await Payment.findOneAndUpdate(
    incrementFilter,
    {
      $inc: { gatewayReconcileAttempts: 1 },
      $set: {
        gatewayLastReconcileAt: now,
        ...(providerState ? { gatewayLastProviderState: providerState } : {}),
        ...(errorMessage ? { gatewayLastReconcileError: errorMessage.slice(0, 500) } : {}),
      },
    },
    { new: true },
  ).lean();
  if (!updated) {
    return resolveProgressOutcomeFromRow(
      paymentId,
      tenantId,
      leaseOwner,
      progressOutcome,
      providerState,
    );
  }
  const attempts = updated.gatewayReconcileAttempts ?? 0;
  if (attempts >= maxAttempts) {
    await reconcileTestHookBeforeExhaustionTransition();
    const exhausted = await Payment.findOneAndUpdate(
      progressFollowUpFence({ paymentId, tenantId, attempts, leaseOwner }),
      {
        $set: {
          gatewayReconcileNextAt: null,
          gatewayLastReconcileOutcome: "RECONCILE_EXHAUSTED",
          requiresReview: true,
          reviewReason: "GATEWAY_RECONCILE_EXHAUSTED",
        },
      },
      { new: true },
    ).lean();
    if (exhausted) {
      await upsertReconcileExhaustedAlert({
        tenantId,
        paymentId,
        merchantOrderId,
        attempts,
        detail: errorMessage
          ? "PhonePe order status could not be retrieved after repeated attempts."
          : "PhonePe order remained pending or incomplete after the configured reconcile attempt limit.",
      });
      recordPhonePeReconcileOutcome("RECONCILE_EXHAUSTED");
      return { outcome: "RECONCILE_EXHAUSTED", providerState, progressOutcome, attempts };
    }
    return resolveProgressOutcomeFromRow(
      paymentId,
      tenantId,
      leaseOwner,
      progressOutcome,
      providerState,
    );
  }
  const backoff = await Payment.updateOne(
    progressFollowUpFence({ paymentId, tenantId, attempts, leaseOwner }),
    {
      $set: {
        gatewayReconcileNextAt: backoffNextAt(attempts),
        gatewayLastReconcileOutcome: progressOutcome,
      },
    },
  );
  if (backoff.modifiedCount === 0) {
    return resolveProgressOutcomeFromRow(
      paymentId,
      tenantId,
      leaseOwner,
      progressOutcome,
      providerState,
    );
  }
  return { outcome: progressOutcome, providerState, attempts };
}

function reconcileProgressContext(payment, fields) {
  return {
    ...fields,
    leaseOwner: payment.gatewayReconcileLeaseOwner ?? null,
  };
}

function propagateProgressUnlessExpected(progress, expectedOutcome) {
  if (progress.outcome === "RECONCILE_EXHAUSTED") return progress;
  if (progress.outcome !== expectedOutcome) return progress;
  return null;
}

export async function clearReconcileLease(paymentId, tenantId, leaseOwner) {
  if (!leaseOwner) {
    throw new Error("clearReconcileLease requires leaseOwner");
  }
  const result = await Payment.updateOne(
    { _id: paymentId, tenantId, gatewayReconcileLeaseOwner: leaseOwner },
    {
      $unset: {
        gatewayReconcileLeaseOwner: "",
        gatewayReconcileLeaseExpiresAt: "",
      },
    },
  );
  return result.modifiedCount;
}

async function markReconcileTerminalOutcome(payment, outcomeLabel, extraSet = {}) {
  await Payment.updateOne(
    { _id: payment._id, tenantId: payment.tenantId },
    {
      $set: {
        gatewayLastReconcileAt: new Date(),
        gatewayLastReconcileOutcome: outcomeLabel,
        ...extraSet,
      },
      $unset: {
        gatewayLastReconcileError: "",
      },
    },
  );
}

export async function reconcileGatewayPayment(payment, {
  source = "RECONCILE_JOB",
  webhookEventId = null,
  leaseWorkerLabel = null,
} = {}) {
  let working = payment;
  let leaseToken = payment.gatewayReconcileLeaseOwner ?? null;
  if (leaseWorkerLabel) {
    const claimed = await claimPaymentForReconcile({
      paymentId: payment._id,
      tenantId: payment.tenantId,
      workerLabel: leaseWorkerLabel,
      now: new Date(),
    });
    if (!claimed) return { outcome: "LEASE_BUSY" };
    working = claimed;
    leaseToken = claimed.gatewayReconcileLeaseOwner;
  }
  try {
    return await reconcileGatewayPaymentCore(working, {
      source,
      webhookEventId,
      expectedLeaseOwner: leaseToken,
    });
  } finally {
    if (leaseToken) {
      await clearReconcileLease(working._id, working.tenantId, leaseToken);
    }
  }
}

async function reconcileGatewayPaymentCore(payment, {
  source = "RECONCILE_JOB",
  webhookEventId = null,
  expectedLeaseOwner = null,
} = {}) {
  await reconcileTestHookBeforeReconcileCore();

  const refetched = await refetchPaymentForReconcileCore(payment, expectedLeaseOwner);
  if (refetched.earlyOutcome) return refetched.earlyOutcome;
  payment = refetched.payment;

  const merchantOrderId = await resolveMerchantOrderIdForPayment(payment);

  const thresholdExhausted = await establishReconcileExhaustedIfAtThreshold(payment, merchantOrderId);
  if (thresholdExhausted) return thresholdExhausted;

  if (!merchantOrderId) {
    const progress = await recordNonTerminalReconcileProgress(
      payment._id,
      payment.tenantId,
      null,
      reconcileProgressContext(payment, {
        progressOutcome: "NO_MERCHANT_ORDER_ID",
        errorMessage: "No merchant order reference for pending gateway payment.",
      }),
    );
    const early = propagateProgressUnlessExpected(progress, "NO_MERCHANT_ORDER_ID");
    if (early) return early;
    recordPhonePeReconcileOutcome("NO_MERCHANT_ORDER_ID");
    return progress;
  }

  const tenant = await Tenant.findById(payment.tenantId).select("+integrationSecrets").lean();
  const credentials = resolvePhonePeCredentials(tenant);
  if (!credentials && env.PROVIDER_MODE !== "mock") {
    const progress = await recordNonTerminalReconcileProgress(
      payment._id,
      payment.tenantId,
      merchantOrderId,
      reconcileProgressContext(payment, {
        progressOutcome: "NO_CREDENTIALS",
        errorMessage: "PhonePe credentials not configured for tenant.",
      }),
    );
    const early = propagateProgressUnlessExpected(progress, "NO_CREDENTIALS");
    if (early) return early;
    recordPhonePeReconcileOutcome("NO_CREDENTIALS");
    return progress;
  }

  let orderResponse;
  try {
    orderResponse = await phonePeProvider.getOrderStatus(
      merchantOrderId,
      credentials,
      payment.tenantId,
    );
  } catch (error) {
    const progress = await recordNonTerminalReconcileProgress(
      payment._id,
      payment.tenantId,
      merchantOrderId,
      reconcileProgressContext(payment, {
        progressOutcome: "TRANSIENT_ERROR",
        errorMessage: error.message,
      }),
    );
    const early = propagateProgressUnlessExpected(progress, "TRANSIENT_ERROR");
    if (early) return early.outcome === "TRANSIENT_ERROR" ? { ...early, error: error.message } : early;
    recordPhonePeReconcileOutcome("TRANSIENT_ERROR");
    return { ...progress, error: error.message };
  }

  const normalized = normalizePhonePeOrderStatus(orderResponse);
  const { intent, link } = await loadIntentAndLink({
    tenantId: payment.tenantId,
    paymentId: payment._id,
    merchantOrderId,
  });
  const reference = merchantOrderId;

  if (normalized.kind === PhonePeOrderStatusKind.COMPLETED) {
    const verified = validatePhonePeCompletedIdentifiers({ merchantOrderId, normalized });
    if (!verified.ok) {
      const progress = await recordNonTerminalReconcileProgress(
        payment._id,
        payment.tenantId,
        merchantOrderId,
        reconcileProgressContext(payment, {
          progressOutcome: verified.code,
          errorMessage: `PhonePe COMPLETED response missing required field: ${verified.code}`,
          providerState: normalized.state,
        }),
      );
      const early = propagateProgressUnlessExpected(progress, verified.code);
      if (early) {
        if (early.outcome === verified.code) recordPhonePeReconcileOutcome(verified.code);
        return early;
      }
      recordPhonePeReconcileOutcome(verified.code);
      return progress;
    }

    const wasExpiredIntent = intent?.status === PaymentIntentStatus.EXPIRED;
    const finalized = await finalizeGatewaySuccess({
      tenantId: payment.tenantId,
      reference,
      transactionId: verified.transactionId,
      amountPaise: verified.amountPaise,
      providerPayload: { source, orderStatus: normalized.raw },
      webhookEventId: webhookEventId ?? `reconcile_${payment._id}`,
      intent,
      link,
    });

    if (finalized.outcome === GatewayFinalizeOutcome.AMOUNT_MISMATCH) {
      await markReconcileTerminalOutcome(payment, "AMOUNT_MISMATCH");
      recordPhonePeReconcileOutcome("AMOUNT_MISMATCH");
      return { outcome: "AMOUNT_MISMATCH", paymentId: payment._id };
    }
    if (finalized.outcome !== GatewayFinalizeOutcome.SUCCESS
      && finalized.outcome !== GatewayFinalizeOutcome.ALREADY_SUCCESS) {
      const progress = await recordNonTerminalReconcileProgress(
        payment._id,
        payment.tenantId,
        merchantOrderId,
        reconcileProgressContext(payment, {
          progressOutcome: "REVIEW_REQUIRED",
          errorMessage: `Finalization returned ${finalized.outcome}`,
          providerState: normalized.state,
        }),
      );
      const early = propagateProgressUnlessExpected(progress, "REVIEW_REQUIRED");
      if (early) {
        if (early.outcome === "REVIEW_REQUIRED") recordPhonePeReconcileOutcome("REVIEW_REQUIRED");
        return early;
      }
      recordPhonePeReconcileOutcome("REVIEW_REQUIRED");
      return progress;
    }

    await markReconcileTerminalOutcome(payment, "COMPLETED");
    if (wasExpiredIntent && finalized.payment) {
      await Payment.updateOne(
        { _id: payment._id, tenantId: payment.tenantId },
        {
          $set: {
            isLateSuccess: true,
            lateSuccessDetectedVia: LateSuccessDetection.RECONCILIATION_JOB,
          },
        },
      );
    }
    recordPhonePeReconcileOutcome("COMPLETED");
    return {
      outcome: "COMPLETED",
      paymentId: finalized.payment?._id ?? payment._id,
    };
  }

  if (normalized.kind === PhonePeOrderStatusKind.TERMINAL_FAILED) {
    await reconcileTestHookBeforeTerminalFailure();
    const terminalResult = await applyTerminalGatewayFailure({
      tenantId: payment.tenantId,
      paymentId: payment._id,
      transactionId: normalized.transactionId ?? null,
      reference,
      providerPayload: { source, orderStatus: normalized.raw },
    });
    const refreshed = await Payment.findOne({
      _id: payment._id,
      tenantId: payment.tenantId,
    }).lean();
    if (terminalResult.skipped) {
      if (terminalResult.reason === "ALREADY_SUCCESS"
        || refreshed?.status === PaymentStatus.SUCCESS) {
        await markReconcileTerminalOutcome(payment, "COMPLETED_ALREADY");
        recordPhonePeReconcileOutcome("COMPLETED_ALREADY");
        return { outcome: "COMPLETED_ALREADY", paymentId: refreshed?._id ?? payment._id };
      }
      if (terminalResult.reason === "NO_PENDING_PAYMENT") {
        const outcome = refreshed?.status === PaymentStatus.FAILED
          ? "TERMINAL_FAILED"
          : "NO_PENDING_PAYMENT";
        await markReconcileTerminalOutcome(payment, outcome);
        recordPhonePeReconcileOutcome(outcome);
        return { outcome, paymentId: payment._id };
      }
      if (terminalResult.reason === "NO_MATCH_KEYS") {
        recordPhonePeReconcileOutcome("NO_MATCH_KEYS");
        return { outcome: "NO_MATCH_KEYS" };
      }
      await markReconcileTerminalOutcome(payment, "TERMINAL_SKIPPED");
      recordPhonePeReconcileOutcome("TERMINAL_SKIPPED");
      return { outcome: "TERMINAL_SKIPPED", reason: terminalResult.reason };
    }
    await markReconcileTerminalOutcome(payment, "TERMINAL_FAILED");
    recordPhonePeReconcileOutcome("TERMINAL_FAILED");
    return { outcome: "TERMINAL_FAILED", paymentId: refreshed?._id ?? payment._id };
  }

  const progress = await recordNonTerminalReconcileProgress(
    payment._id,
    payment.tenantId,
    merchantOrderId,
    reconcileProgressContext(payment, {
      progressOutcome: "STILL_PENDING",
      providerState: normalized.state,
    }),
  );
  const early = propagateProgressUnlessExpected(progress, "STILL_PENDING");
  if (early) return early;
  recordPhonePeReconcileOutcome("STILL_PENDING");
  return { outcome: "STILL_PENDING", providerState: normalized.state, attempts: progress.attempts };
}

export async function claimPaymentForReconcile({ paymentId, tenantId, workerLabel, now }) {
  const leaseToken = buildReconcileLeaseToken(workerLabel, paymentId);
  return Payment.findOneAndUpdate(
    {
      _id: paymentId,
      tenantId,
      status: PaymentStatus.PENDING,
      mode: PaymentMode.ONLINE_GATEWAY,
      reviewReason: { $ne: "GATEWAY_RECONCILE_EXHAUSTED" },
      $or: [
        { gatewayReconcileLeaseExpiresAt: { $exists: false } },
        { gatewayReconcileLeaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        gatewayReconcileLeaseOwner: leaseToken,
        gatewayReconcileLeaseExpiresAt: new Date(now.getTime() + reconcileLeaseMs()),
      },
    },
    { new: true },
  ).lean();
}

export async function runPhonePeReconciliation(workerId = "scheduler") {
  const now = new Date();
  const staleBefore = staleCutoff();
  const batchSize = env.PHONEPE_RECONCILE_BATCH_SIZE ?? 50;
  const leaseExpired = { $lte: now };

  const candidates = await Payment.find({
    status: PaymentStatus.PENDING,
    mode: PaymentMode.ONLINE_GATEWAY,
    reviewReason: { $ne: "GATEWAY_RECONCILE_EXHAUSTED" },
    $and: [
      {
        $or: [
          { gatewayReconcileNextAt: { $lte: now } },
          {
            gatewayReconcileNextAt: { $exists: false },
            paidAt: { $lte: staleBefore },
          },
        ],
      },
      {
        $or: [
          { gatewayReconcileLeaseExpiresAt: { $exists: false } },
          { gatewayReconcileLeaseExpiresAt: leaseExpired },
        ],
      },
    ],
  })
    .sort({ _id: 1 })
    .limit(batchSize)
    .lean();

  let processed = 0;
  for (const row of candidates) {
    const claimed = await claimPaymentForReconcile({
      paymentId: row._id,
      tenantId: row.tenantId,
      workerLabel: workerId,
      now,
    });
    if (!claimed) continue;
    try {
      await reconcileGatewayPayment(claimed);
    } catch (error) {
      logger.warn(
        { paymentId: row._id, err: error.message },
        "PhonePe reconciliation item failed",
      );
    }
    processed += 1;
  }
  return { scanned: candidates.length, processed };
}

export async function reconcilePaymentById({ tenantId, paymentId, forceReplay = false }) {
  let payment = await Payment.findOne({
    _id: paymentId,
    tenantId,
    status: PaymentStatus.PENDING,
    mode: PaymentMode.ONLINE_GATEWAY,
  }).lean();
  if (!payment) return { outcome: "NOT_FOUND_OR_NOT_PENDING" };
  if (payment.reviewReason === "GATEWAY_RECONCILE_EXHAUSTED" && !forceReplay) {
    return { outcome: "EXHAUSTED_REQUIRES_FORCE" };
  }
  if (forceReplay) {
    await Payment.updateOne(
      { _id: paymentId, tenantId },
      {
        $set: {
          gatewayReconcileAttempts: 0,
          gatewayReconcileNextAt: new Date(),
          requiresReview: false,
        },
        $unset: { reviewReason: "" },
      },
    );
    await Payment.findOne({
      _id: paymentId,
      tenantId,
      status: PaymentStatus.PENDING,
      mode: PaymentMode.ONLINE_GATEWAY,
    }).lean();
  }
  const claimed = await claimPaymentForReconcile({
    paymentId,
    tenantId,
    workerLabel: `manual_${randomToken(6)}`,
    now: new Date(),
  });
  if (!claimed) return { outcome: "LEASE_BUSY" };
  return reconcileGatewayPayment(claimed, {
    source: forceReplay ? "MANUAL_REPLAY" : "MANUAL_RECONCILE",
  });
}
