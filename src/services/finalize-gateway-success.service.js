import { AuditEntityType, LinkStatus, PaymentIntentStatus, PaymentStatus } from "../constants/enums.js";
import { isFixedReservationIntent } from "../lib/fixed-payment-reservation.js";
import { gatewayTxFaultCheckpoint } from "../lib/gateway-tx-faults.js";
import { recordPhonePeDriftRepaired } from "../lib/ops-metrics.js";
import { withTransaction } from "../lib/transaction.js";
import { Alert, Payment, PaymentIntent, PaymentLink, Scheme } from "../models/index.js";
import { writeAudit } from "./audit.service.js";
import { recordPayment } from "./payment.service.js";

export const GatewayFinalizeOutcome = Object.freeze({
  SUCCESS: "SUCCESS",
  ALREADY_SUCCESS: "ALREADY_SUCCESS",
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
  NO_SOURCE: "NO_SOURCE",
});

function buildGatewayReq({ tenantId, source, webhookEventId }) {
  return {
    auth: { id: "phonepe", tenantId, type: "WEBHOOK" },
    scope: { tenantId },
    body: {
      schemeId: source.schemeId,
      amountPaise: source.amountPaise,
      mode: "ONLINE_GATEWAY",
      targetCycle: source.targetCycle,
      positionVersion: source.positionVersion,
    },
    query: { targetCycle: source.targetCycle },
    baseUrl: "/webhooks",
    traceId: webhookEventId,
    ip: "provider",
    headers: {},
  };
}

async function repairIntentAndLink({
  tenantId,
  reference,
  paymentId,
  intent,
  link,
  session = null,
}) {
  const writeOpts = session ? { session } : {};
  let repaired = false;
  if (intent && intent.status !== "SUCCEEDED") {
    const updated = await PaymentIntent.updateOne(
      { _id: intent._id, tenantId },
      { $set: { status: "SUCCEEDED", paymentId }, $inc: { version: 1 } },
      writeOpts,
    );
    if (updated.modifiedCount) repaired = true;
  }
  if (link && link.status !== LinkStatus.PAID) {
    const updated = await PaymentLink.updateOne(
      { _id: link._id, tenantId },
      { $set: { status: LinkStatus.PAID, paidAt: new Date(), paymentId } },
      writeOpts,
    );
    if (updated.modifiedCount) repaired = true;
    if (link.paymentIntentId) {
      const intentUpdated = await PaymentIntent.updateOne(
        { _id: link.paymentIntentId, tenantId, status: { $ne: "SUCCEEDED" } },
        { $set: { status: "SUCCEEDED", paymentId }, $inc: { version: 1 } },
        writeOpts,
      );
      if (intentUpdated.modifiedCount) repaired = true;
    }
  }
  if (!intent && !link && reference) {
    const updated = await PaymentIntent.updateOne(
      {
        tenantId,
        $or: [{ _id: reference }, { providerOrderId: reference }],
        status: { $ne: "SUCCEEDED" },
      },
      { $set: { status: "SUCCEEDED", paymentId }, $inc: { version: 1 } },
      writeOpts,
    );
    if (updated.modifiedCount) repaired = true;
  }
  return repaired;
}

async function repairDriftTransactional({ tenantId, reference, paymentId, intent, link }) {
  return withTransaction(async (session) => {
    const repaired = await repairIntentAndLink({
      tenantId,
      reference,
      paymentId,
      intent,
      link,
      session,
    });
    return repaired;
  });
}

async function applyAmountMismatchAtomic({
  tenantId,
  source,
  intent,
  link,
  amountPaise,
  providerPayload,
  webhookEventId,
}) {
  const paymentId = source.paymentId;
  await withTransaction(async (session) => {
    const payment = await Payment.findOneAndUpdate(
      {
        _id: paymentId,
        tenantId,
        status: PaymentStatus.PENDING,
      },
      {
        $set: {
          status: PaymentStatus.AMOUNT_MISMATCH_PENDING_REVIEW,
          requiresReview: true,
          reviewReason: "GATEWAY_AMOUNT_MISMATCH",
          providerPayload,
        },
      },
      { new: true, session },
    );
    if (!payment) {
      throw new Error("GATEWAY_MISMATCH_PAYMENT_NOT_PENDING");
    }
    gatewayTxFaultCheckpoint("mismatch:payment-updated");

    if (intent) {
      await PaymentIntent.updateOne(
        { _id: intent._id, tenantId, status: "PENDING" },
        { $set: { status: "FAILED" }, $inc: { version: 1 } },
        { session },
      );
    }
    gatewayTxFaultCheckpoint("mismatch:intent-updated");

    if (link) {
      await PaymentLink.updateOne(
        {
          _id: link._id,
          tenantId,
          status: { $in: [LinkStatus.CREATED, LinkStatus.SENT, LinkStatus.OPENED] },
        },
        { $set: { status: LinkStatus.EXPIRED } },
        { session },
      );
    } else if (paymentId) {
      await PaymentLink.updateMany(
        {
          tenantId,
          paymentId,
          status: { $in: [LinkStatus.CREATED, LinkStatus.SENT, LinkStatus.OPENED] },
        },
        { $set: { status: LinkStatus.EXPIRED } },
        { session },
      );
    }
    gatewayTxFaultCheckpoint("mismatch:link-updated");

    const schemeId = intent?.schemeId ?? link?.schemeId;
    if (schemeId) {
      await Scheme.updateOne(
        { _id: schemeId, tenantId },
        { $inc: { positionVersion: 1, version: 1 } },
        { session },
      );
    }
    gatewayTxFaultCheckpoint("mismatch:scheme-updated");

    await Alert.findOneAndUpdate(
      {
        tenantId,
        type: "GATEWAY_AMOUNT_MISMATCH",
        entityId: paymentId,
        status: "OPEN",
      },
      {
        $setOnInsert: {
          branchId: source.branchId,
          severity: "CRITICAL",
          title: "Gateway amount mismatch",
          message: "A verified gateway callback amount did not match the reserved payment amount.",
          entityType: "PAYMENT",
          metadata: {
            expectedPaise: source.amountPaise,
            receivedPaise: amountPaise,
          },
        },
      },
      { upsert: true, session },
    );
    gatewayTxFaultCheckpoint("mismatch:alert-upserted");

    await writeAudit({
      req: {
        auth: { id: "phonepe", tenantId, type: "WEBHOOK" },
        headers: {},
        ip: "provider",
        traceId: webhookEventId,
      },
      action: "GATEWAY_AMOUNT_MISMATCH",
      entityType: AuditEntityType.PAYMENT,
      entityId: paymentId,
      after: payment.toObject(),
      metadata: { expectedPaise: source.amountPaise, receivedPaise: amountPaise },
      actorType: "WEBHOOK",
      session,
    });
    gatewayTxFaultCheckpoint("mismatch:audit-written");
  });
}

/**
 * Idempotent gateway success: one payment per provider transaction; repair intent/link if already paid.
 */
export async function finalizeGatewaySuccess({
  tenantId,
  reference,
  transactionId,
  amountPaise,
  providerPayload,
  webhookEventId,
  intent = null,
  link = null,
  paymentId: explicitPaymentId = null,
}) {
  if (transactionId) {
    const existing = await Payment.findOne({
      tenantId,
      providerTransactionId: transactionId,
      status: {
        $in: [PaymentStatus.SUCCESS, PaymentStatus.UNALLOCATED_PENDING_REVIEW],
      },
    }).lean();
    if (existing) {
      const repaired = await repairDriftTransactional({
        tenantId,
        reference,
        paymentId: existing._id,
        intent,
        link,
      });
      if (repaired) recordPhonePeDriftRepaired();
      return { outcome: GatewayFinalizeOutcome.ALREADY_SUCCESS, payment: existing };
    }
  }

  const source = intent ?? link;
  if (!source) {
    return { outcome: GatewayFinalizeOutcome.NO_SOURCE };
  }

  if (Number(amountPaise) !== Number(source.amountPaise)) {
    await applyAmountMismatchAtomic({
      tenantId,
      source,
      intent,
      link,
      amountPaise,
      providerPayload,
      webhookEventId,
    });
    return { outcome: GatewayFinalizeOutcome.AMOUNT_MISMATCH };
  }

  const payment = await withTransaction(async (session) => {
    let resolvedSource = source;
    let freshIntent = null;
    if (intent?._id) {
      freshIntent = await PaymentIntent.findOne({
        _id: intent._id,
        tenantId,
      })
        .session(session)
        .lean();
      if (freshIntent) resolvedSource = freshIntent;
    } else if (link?._id) {
      const freshLink = await PaymentLink.findOne({
        _id: link._id,
        tenantId,
      })
        .session(session)
        .lean();
      if (freshLink) {
        resolvedSource = freshLink;
        if (freshLink.paymentIntentId) {
          freshIntent = await PaymentIntent.findOne({
            _id: freshLink.paymentIntentId,
            tenantId,
          })
            .session(session)
            .lean();
        }
      }
    }
    const lateSuccess = intent
      ? resolvedSource.status !== PaymentIntentStatus.PENDING
      : !["CREATED", "SENT", "OPENED"].includes(resolvedSource.status);

    let resolvedPaymentId = explicitPaymentId ?? resolvedSource.paymentId;
    if (!resolvedPaymentId && resolvedSource.schemeId) {
      const reserved = await Payment.findOne({
        tenantId,
        schemeId: resolvedSource.schemeId,
        status: { $in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
      })
        .sort({ createdAt: -1 })
        .select("_id")
        .session(session)
        .lean();
      resolvedPaymentId = reserved?._id ?? null;
    }

    const recorded = await recordPayment(buildGatewayReq({ tenantId, source: resolvedSource, webhookEventId }), {
      gateway: true,
      source: "WEBHOOK",
      actorType: "WEBHOOK",
      existingPaymentId: resolvedPaymentId,
      providerTransactionId: transactionId,
      providerPayload,
      lateSuccess,
      lateSuccessDetectedVia: lateSuccess ? "WEBHOOK" : undefined,
      gatewayCompletedAt: new Date(),
      fixedReservationIntent: isFixedReservationIntent(freshIntent)
        ? freshIntent
        : null,
      session,
    });

    await repairIntentAndLink({
      tenantId,
      reference,
      paymentId: recorded._id,
      intent,
      link,
      session,
    });

    return recorded;
  });

  return { outcome: GatewayFinalizeOutcome.SUCCESS, payment };
}
