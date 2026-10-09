import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import {
  EcommercePaymentAttemptOperationalStatus,
  EcommercePaymentAttemptStatus,
} from "../constants/enums.js";
import { phonePeProvider, resolvePhonePeCredentials } from "../integrations/phonepe.provider.js";
import { randomToken } from "../lib/crypto.js";
import { validatePhonePeCompletedIdentifiers } from "../lib/phonepe-completed-identifiers.js";
import { PhonePeOrderStatusKind, normalizePhonePeOrderStatus } from "../lib/phonepe-order-status.js";
import { EcommercePaymentAttempt, Tenant } from "../models/index.js";
import {
  finalizeEcommercePaymentSuccess,
  finalizeEcommercePaymentTerminalFailure,
} from "./ecommerce-payment-finalize.service.js";

function staleCutoffMs() {
  return env.PHONEPE_RECONCILE_STALE_SECONDS ?? 900;
}

function batchSize() {
  return env.ECOMMERCE_PAYMENT_RECONCILE_BATCH_SIZE ?? 50;
}

function leaseMs() {
  return env.ECOMMERCE_PAYMENT_RECONCILE_LEASE_MS ?? 120_000;
}

function maxAttempts() {
  return env.ECOMMERCE_PAYMENT_RECONCILE_MAX_ATTEMPTS ?? 12;
}

function backoffNextAt(attempts) {
  const baseSec = Math.min(3600, 60 * 2 ** Math.min(attempts, 6));
  const jitterSec = Math.floor(Math.random() * Math.min(30, Math.max(1, baseSec)));
  return new Date(Date.now() + (baseSec + jitterSec) * 1000);
}

function buildLeaseToken(attemptId) {
  return `ecrec_${attemptId}_${randomToken(8)}`;
}

export async function claimEcommercePaymentAttemptForReconcile(attemptId, at = new Date()) {
  const leaseOwner = buildLeaseToken(attemptId);
  const leaseExpires = new Date(at.getTime() + leaseMs());
  return EcommercePaymentAttempt.findOneAndUpdate(
    {
      _id: attemptId,
      status: EcommercePaymentAttemptStatus.INITIATED,
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

export async function reconcileEcommercePaymentAttempt(attemptRow, { at = new Date(), leaseOwner } = {}) {
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
      "Ecommerce payment reconcile status poll failed",
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
    const result = await finalizeEcommercePaymentSuccess({
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
    const result = await finalizeEcommercePaymentTerminalFailure({
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

async function releaseReconcileLease(attemptId, leaseOwner) {
  if (!leaseOwner) return;
  await EcommercePaymentAttempt.updateOne(
    { _id: attemptId, gatewayReconcileLeaseOwner: leaseOwner },
    {
      $set: {
        gatewayReconcileLeaseOwner: null,
        gatewayReconcileLeaseExpiresAt: null,
        operationalStatus: EcommercePaymentAttemptOperationalStatus.NORMAL,
      },
    },
  );
}

async function recordReconcileProgress(attemptRow, { leaseOwner, outcome, at, errorMessage, providerState }) {
  const attempts = (attemptRow.gatewayReconcileAttempts ?? 0) + 1;
  const stuck = attempts >= maxAttempts();
  await EcommercePaymentAttempt.updateOne(
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
        operationalStatus: stuck
          ? EcommercePaymentAttemptOperationalStatus.STUCK_RECONCILE
          : EcommercePaymentAttemptOperationalStatus.AWAITING_PROVIDER,
        ...(errorMessage ? { failureReason: String(errorMessage).slice(0, 120) } : {}),
        ...(providerState ? { providerPayload: { lastProviderState: providerState } } : {}),
      },
      $inc: { version: 1 },
    },
  );
}

export async function runEcommercePaymentReconcile(at = new Date()) {
  const cutoff = new Date(at.getTime() - staleCutoffMs() * 1000);
  const rows = await EcommercePaymentAttempt.find({
    status: EcommercePaymentAttemptStatus.INITIATED,
    providerOrderId: { $exists: true, $ne: "" },
    updatedAt: { $lte: cutoff },
    operationalStatus: {
      $ne: EcommercePaymentAttemptOperationalStatus.STUCK_RECONCILE,
    },
    $or: [{ gatewayReconcileNextAt: { $lte: at } }, { gatewayReconcileNextAt: null }],
  })
    .sort({ gatewayReconcileNextAt: 1, updatedAt: 1 })
    .limit(batchSize())
    .lean();
  const summary = { scanned: rows.length, outcomes: {} };
  for (const row of rows) {
    const claimed = await claimEcommercePaymentAttemptForReconcile(row._id, at);
    if (!claimed) {
      summary.outcomes.LEASE_NOT_ACQUIRED = (summary.outcomes.LEASE_NOT_ACQUIRED ?? 0) + 1;
      continue;
    }
    const result = await reconcileEcommercePaymentAttempt(claimed, {
      at,
      leaseOwner: claimed.gatewayReconcileLeaseOwner,
    });
    const key = result.outcome ?? "UNKNOWN";
    summary.outcomes[key] = (summary.outcomes[key] ?? 0) + 1;
  }
  return summary;
}
