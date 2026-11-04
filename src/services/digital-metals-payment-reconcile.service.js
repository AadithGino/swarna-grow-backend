import { withTransaction } from "../lib/transaction.js";
import { checkoutReconcileFilter } from "../lib/checkout-reconcile-filter.js";
import { upsertOperationalAlert } from "../lib/operational-alert.js";
import { AlertType } from "../constants/enums.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { phonePeProvider, resolvePhonePeCredentials } from "../integrations/phonepe.provider.js";
import { randomToken } from "../lib/crypto.js";
import { validatePhonePeCompletedIdentifiers } from "../lib/phonepe-completed-identifiers.js";
import { PhonePeOrderStatusKind, normalizePhonePeOrderStatus } from "../lib/phonepe-order-status.js";
import { Tenant, DigitalMetalBuyPaymentAttempt, DigitalMetalBuyOrder } from "../models/index.js";
import {
  finalizeDigitalMetalBuyPaymentSuccess,
  finalizeDigitalMetalBuyPaymentTerminalFailure,
  recoverDigitalMetalBuyOrderCredit,
} from "./digital-metals-buy-finalize.service.js";
import { isMockDigitalMetalsPaymentAttempt } from "../lib/digital-metals-checkout-init.js";

/** Min gap between customer-visible PhonePe status polls (webhook remains primary). */
const CUSTOMER_VISIBLE_RECONCILE_MIN_MS = 8_000;

function isLiveGatewayBuyAttempt(attempt) {
  if (!attempt?.providerOrderId) return false;
  if (isMockDigitalMetalsPaymentAttempt(attempt)) return false;
  if (attempt.checkoutMode && attempt.checkoutMode !== "LIVE") return false;
  return true;
}

export async function maybeReconcileLiveDigitalMetalBuyAttempt(attempt, { at = new Date(), force = false } = {}) {
  if (!attempt || !isLiveGatewayBuyAttempt(attempt)) return { reconciled: false };
  if (attempt.status !== "INITIATED" && attempt.status !== "PENDING") return { reconciled: false };
  const lastAt = attempt.gatewayLastReconcileAt
    ? new Date(attempt.gatewayLastReconcileAt).getTime()
    : 0;
  if (!force && lastAt && at.getTime() - lastAt < CUSTOMER_VISIBLE_RECONCILE_MIN_MS) {
    return { reconciled: false, skipped: "THROTTLED" };
  }
  const result = await reconcileDigitalMetalBuyPaymentAttempt(attempt, { at });
  return { reconciled: true, result };
}

/** Poll PhonePe when the customer app refreshes order / payment-intent (fallback if webhook missed). */
export async function refreshDigitalMetalBuyOrderFromPhonePe({ tenantId, order }) {
  if (!order) return { order: null, attempts: [] };
  const terminalOrder = ["CREDITED", "REFUNDED", "REFUND_REVIEW"].includes(order.status);
  let attempts = await DigitalMetalBuyPaymentAttempt.find({
    tenantId,
    orderId: order._id,
  })
    .sort({ createdAt: -1 })
    .lean();
  if (terminalOrder) return { order, attempts };

  const candidate = attempts.find(
    (row) => ["INITIATED", "PENDING"].includes(row.status) && isLiveGatewayBuyAttempt(row),
  );
  if (candidate) {
    await maybeReconcileLiveDigitalMetalBuyAttempt(candidate, { at: new Date() });
    const freshOrder = await DigitalMetalBuyOrder.findById(order._id).lean();
    attempts = await DigitalMetalBuyPaymentAttempt.find({ tenantId, orderId: order._id })
      .sort({ createdAt: -1 })
      .lean();
    return { order: freshOrder ?? order, attempts };
  }
  return { order, attempts };
}

function staleCutoffMs() {
  return env.PHONEPE_RECONCILE_STALE_SECONDS ?? 900;
}

function batchSize() {
  return env.DIGITAL_METALS_PAYMENT_RECONCILE_BATCH_SIZE ?? 50;
}

function leaseMs() {
  return env.DIGITAL_METALS_PAYMENT_RECONCILE_LEASE_MS ?? 120_000;
}

function maxAttempts() {
  return env.DIGITAL_METALS_PAYMENT_RECONCILE_MAX_ATTEMPTS ?? 12;
}

function backoffNextAt(attempts) {
  const baseSec = Math.min(3600, 60 * 2 ** Math.min(attempts, 6));
  const jitterSec = Math.floor(Math.random() * Math.min(30, Math.max(1, baseSec)));
  return new Date(Date.now() + (baseSec + jitterSec) * 1000);
}

function buildLeaseToken(attemptId) {
  return `dmrec_${attemptId}_${randomToken(8)}`;
}

export async function claimDigitalMetalBuyPaymentAttemptForReconcile(attemptId, at = new Date()) {
  const leaseOwner = buildLeaseToken(attemptId);
  const leaseExpires = new Date(at.getTime() + leaseMs());
  return DigitalMetalBuyPaymentAttempt.findOneAndUpdate(
    {
      _id: attemptId,
      status: { $in: ["PENDING", "INITIATED"] },
      $and: [
        {
          $or: [
            { gatewayReconcileLeaseExpiresAt: { $lte: at } },
            { gatewayReconcileLeaseExpiresAt: null },
            { gatewayReconcileLeaseExpiresAt: { $exists: false } },
          ],
        },
        {
          $or: [
            { gatewayReconcileNextAt: { $lte: at } },
            { gatewayReconcileNextAt: null },
            { gatewayReconcileNextAt: { $exists: false } },
          ],
        },
      ],
    },
    {
      $set: {
        gatewayReconcileLeaseOwner: leaseOwner,
        gatewayReconcileLeaseExpiresAt: leaseExpires,
      },
    },
    { new: true },
  ).lean();
}

async function releaseReconcileLease(attemptId, leaseOwner) {
  if (!leaseOwner) return;
  await DigitalMetalBuyPaymentAttempt.updateOne(
    { _id: attemptId, gatewayReconcileLeaseOwner: leaseOwner },
    {
      $set: {
        gatewayReconcileLeaseOwner: null,
        gatewayReconcileLeaseExpiresAt: null,
      },
    },
  );
}

async function recordReconcileProgress(attemptRow, { leaseOwner, outcome, at, errorMessage, providerState }) {
  const attempts = (attemptRow.gatewayReconcileAttempts ?? 0) + 1;
  const stuck = attempts >= maxAttempts();
  return withTransaction(async (session) => {
  const progressed = await DigitalMetalBuyPaymentAttempt.updateOne(
    {
      _id: attemptRow._id,
      status: { $in: ["PENDING", "INITIATED"] },
      ...(leaseOwner ? { gatewayReconcileLeaseOwner: leaseOwner } : {}),
    },
    {
      $set: {
        gatewayReconcileAttempts: attempts,
        gatewayLastReconcileAt: at,
        gatewayLastReconcileOutcome: outcome,
        gatewayReconcileNextAt: stuck ? null : backoffNextAt(attempts),
        gatewayReconcileLeaseOwner: null,
        gatewayReconcileLeaseExpiresAt: null,
        ...(errorMessage ? { failureReason: String(errorMessage).slice(0, 120) } : {}),
        ...(providerState ? { providerPayload: { lastProviderState: providerState } } : {}),
      },
      $inc: { version: 1 },
    },
    { session },
  );
  if (stuck && progressed.modifiedCount === 1) await upsertOperationalAlert({ tenantId: attemptRow.tenantId,
    session, type: AlertType.GATEWAY_RECONCILE_EXHAUSTED, entityId: attemptRow._id,
    title: "Checkout reconciliation exhausted", message: "Provider outcome remains unresolved. Review before permitting another charge.",
    metadata: { orderId: attemptRow.orderId, paymentAttemptId: attemptRow._id, attempts, outcome } });

  });
}

export async function reconcileDigitalMetalBuyPaymentAttempt(attemptRow, { at = new Date(), leaseOwner } = {}) {
  const tenant = await Tenant.findById(attemptRow.tenantId).select("+integrationSecrets").lean();
  if (!tenant) {
    await recordReconcileProgress(attemptRow, { leaseOwner, at, outcome: "TENANT_MISSING" });
    return { outcome: "TENANT_MISSING" };
  }
  const credentials = resolvePhonePeCredentials(tenant);
  const merchantOrderId = attemptRow.merchantOrderId ?? attemptRow._id;
  let statusPayload;
  try {
    statusPayload = await phonePeProvider.getOrderStatus(
      merchantOrderId,
      credentials,
      attemptRow.tenantId,
    );
  } catch (error) {
    logger.warn(
      { attemptId: attemptRow._id, orderId: attemptRow.orderId, err: error?.message },
      "Digital metal buy payment reconcile status poll failed",
    );
    await recordReconcileProgress(attemptRow, {
      leaseOwner,
      outcome: "POLL_FAILED",
      at,
      errorMessage: error?.message,
    });
    return { outcome: "POLL_FAILED" };
  }
  const normalized = normalizePhonePeOrderStatus(statusPayload);
  if (normalized.kind === PhonePeOrderStatusKind.COMPLETED) {
    const verified = validatePhonePeCompletedIdentifiers({
      merchantOrderId,
      normalized: {
        transactionId: normalized.transactionId,
        amount: normalized.amount ?? attemptRow.amountPaise,
      },
    });
    if (!verified.ok) {
      await recordReconcileProgress(attemptRow, { leaseOwner, at, outcome: "INVALID_COMPLETED", errorMessage: verified.code });
      return { outcome: "INVALID_COMPLETED", code: verified.code };
    }
    const result = await finalizeDigitalMetalBuyPaymentSuccess({
      tenantId: attemptRow.tenantId,
      merchantOrderId,
      transactionId: verified.transactionId,
      amountPaise: verified.amountPaise,
      currency: attemptRow.currency ?? "INR",
      providerPayload: statusPayload,
      webhookEventId: null,
      source: "RECONCILE",
    });
    const latest = await DigitalMetalBuyPaymentAttempt.findById(attemptRow._id).select("status").lean();
    if (latest && !["SUCCEEDED", "FAILED"].includes(latest.status)) {
      await recordReconcileProgress(attemptRow, { leaseOwner, at, outcome: result.outcome ?? "UNRESOLVED" });
    } else await releaseReconcileLease(attemptRow._id, leaseOwner);
    return result;
  }
  if (normalized.kind === PhonePeOrderStatusKind.TERMINAL_FAILED) {
    const result = await finalizeDigitalMetalBuyPaymentTerminalFailure({
      tenantId: attemptRow.tenantId,
      merchantOrderId,
      transactionId: normalized.transactionId,
      providerPayload: statusPayload,
      webhookEventId: null,
      reason: "RECONCILE_TERMINAL_FAILURE",
    });
    const latest = await DigitalMetalBuyPaymentAttempt.findById(attemptRow._id).select("status").lean();
    if (latest && !["SUCCEEDED", "FAILED"].includes(latest.status)) {
      await recordReconcileProgress(attemptRow, { leaseOwner, at, outcome: result.outcome ?? "UNRESOLVED" });
    } else await releaseReconcileLease(attemptRow._id, leaseOwner);
    return result;
  }
  await recordReconcileProgress(attemptRow, {
    leaseOwner,
    outcome: "STILL_PENDING",
    at,
    providerState: normalized.kind,
  });
  return { outcome: "STILL_PENDING" };
}

export async function runDigitalMetalBuyPaymentReconcile(at = new Date()) {
  const cutoff = new Date(at.getTime() - staleCutoffMs() * 1000);
  const rows = await DigitalMetalBuyPaymentAttempt.find({
    ...checkoutReconcileFilter({ at, cutoff, maxAttempts: maxAttempts() }),
  })
    .sort({ gatewayReconcileNextAt: 1, updatedAt: 1 })
    .limit(batchSize())
    .lean();
  const summary = { scanned: rows.length, outcomes: {} };
  for (const row of rows) {
    const claimed = await claimDigitalMetalBuyPaymentAttemptForReconcile(row._id, at);
    if (!claimed) {
      summary.outcomes.LEASE_NOT_ACQUIRED = (summary.outcomes.LEASE_NOT_ACQUIRED ?? 0) + 1;
      continue;
    }
    const result = await reconcileDigitalMetalBuyPaymentAttempt(claimed, {
      at,
      leaseOwner: claimed.gatewayReconcileLeaseOwner,
    });
    const key = result.outcome ?? "UNKNOWN";
    summary.outcomes[key] = (summary.outcomes[key] ?? 0) + 1;
  }

  const creditRecovery = await recoverStuckDigitalMetalBuyCredits(at);
  summary.creditRecovery = creditRecovery;

  const { runDigitalMetalRedemptionChargePaymentReconcile } = await import(
    "./digital-metals-redemption-charge-reconcile.service.js"
  );
  summary.redemptionChargeReconcile = await runDigitalMetalRedemptionChargePaymentReconcile(at);
  return summary;
}

async function recoverStuckDigitalMetalBuyCredits(at = new Date()) {
  const orders = await DigitalMetalBuyOrder.find({
    status: { $in: ["PAYMENT_VERIFIED"] },
    successfulPaymentAttemptId: { $ne: null },
  })
    .limit(batchSize())
    .lean();
  const outcomes = {};
  for (const order of orders) {
    const result = await recoverDigitalMetalBuyOrderCredit(order._id, order.tenantId);
    const key = result.outcome ?? "UNKNOWN";
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
  const stuckAttempts = await DigitalMetalBuyPaymentAttempt.find({
    status: "SUCCEEDED",
  })
    .limit(batchSize())
    .lean();
  for (const attempt of stuckAttempts) {
    const order = await DigitalMetalBuyOrder.findById(attempt.orderId).lean();
    if (!order || order.status === "CREDITED") continue;
    const result = await recoverDigitalMetalBuyOrderCredit(order._id, order.tenantId);
    const key = result.outcome ?? "UNKNOWN";
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
  return { scanned: orders.length, outcomes, at: at.toISOString() };
}
