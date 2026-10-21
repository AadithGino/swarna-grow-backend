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
      status: "INITIATED",
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
  await DigitalMetalBuyPaymentAttempt.updateOne(
    {
      _id: attemptRow._id,
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
  );
}

export async function reconcileDigitalMetalBuyPaymentAttempt(attemptRow, { at = new Date(), leaseOwner } = {}) {
  const tenant = await Tenant.findById(attemptRow.tenantId).select("+integrationSecrets").lean();
  if (!tenant) return { outcome: "TENANT_MISSING" };
  const credentials = resolvePhonePeCredentials(tenant);
  const merchantOrderId = attemptRow.merchantOrderId ?? attemptRow._id;
  const providerOrderId = attemptRow.providerOrderId ?? merchantOrderId;
  let statusPayload;
  try {
    statusPayload = await phonePeProvider.getOrderStatus(
      providerOrderId,
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
      await releaseReconcileLease(attemptRow._id, leaseOwner);
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
    await releaseReconcileLease(attemptRow._id, leaseOwner);
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
    await releaseReconcileLease(attemptRow._id, leaseOwner);
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
    status: "INITIATED",
    providerOrderId: { $exists: true, $ne: "" },
    updatedAt: { $lte: cutoff },
    $or: [{ gatewayReconcileNextAt: { $lte: at } }, { gatewayReconcileNextAt: null }],
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
