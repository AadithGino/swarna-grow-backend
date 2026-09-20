import { AuditEntityType, LinkStatus, PaymentStatus } from "../constants/enums.js";
import { gatewayTxFaultCheckpoint } from "../lib/gateway-tx-faults.js";
import { withTransaction } from "../lib/transaction.js";
import { OutboxEvent, Payment, PaymentIntent, PaymentLink, Scheme } from "../models/index.js";
import { writeAudit } from "./audit.service.js";

const OPEN_LINK_STATUSES = [LinkStatus.CREATED, LinkStatus.SENT, LinkStatus.OPENED];

async function resolvePaymentId({ tenantId, paymentId, reference, transactionId, session }) {
  if (paymentId) return paymentId;
  if (reference) {
    const intent = await PaymentIntent.findOne({
      tenantId,
      $or: [{ _id: reference }, { providerOrderId: reference }],
    })
      .select("paymentId")
      .session(session)
      .lean();
    if (intent?.paymentId) return intent.paymentId;
  }
  const or = [];
  if (transactionId) or.push({ providerTransactionId: transactionId });
  if (reference) or.push({ receiptNumber: `PENDING-${reference}` });
  if (!or.length) return null;
  const row = await Payment.findOne({ tenantId, $or: or })
    .select("_id")
    .session(session)
    .lean();
  return row?._id ?? null;
}

/**
 * Terminal gateway order failure — atomic local state; skips if payment already succeeded.
 */
export async function applyTerminalGatewayFailure({
  tenantId,
  paymentId = null,
  transactionId = null,
  reference = null,
  providerPayload = null,
  session: externalSession = null,
}) {
  const run = async (session) => {
    const successGuard = [];
    if (transactionId) successGuard.push({ providerTransactionId: transactionId });
    if (reference) successGuard.push({ receiptNumber: `PENDING-${reference}` });
    if (paymentId) successGuard.push({ _id: paymentId });
    if (successGuard.length) {
      const alreadySuccess = await Payment.exists({
        tenantId,
        status: PaymentStatus.SUCCESS,
        $or: successGuard,
      }).session(session);
      if (alreadySuccess) return { skipped: true, reason: "ALREADY_SUCCESS" };
    }

    const resolvedPaymentId = await resolvePaymentId({
      tenantId,
      paymentId,
      reference,
      transactionId,
      session,
    });
    if (!resolvedPaymentId) return { skipped: true, reason: "NO_MATCH_KEYS" };

    const pending = await Payment.findOneAndUpdate(
      {
        _id: resolvedPaymentId,
        tenantId,
        status: PaymentStatus.PENDING,
      },
      {
        $set: {
          status: PaymentStatus.FAILED,
          ...(providerPayload ? { providerPayload } : {}),
        },
      },
      { new: true, session },
    );
    if (!pending) return { skipped: true, reason: "NO_PENDING_PAYMENT" };
    gatewayTxFaultCheckpoint("terminalFailure:payment-updated");

    const failedIntent = await PaymentIntent.findOneAndUpdate(
      { tenantId, paymentId: pending._id, status: "PENDING" },
      { $set: { status: "FAILED" }, $inc: { version: 1 } },
      { new: true, session },
    );
    gatewayTxFaultCheckpoint("terminalFailure:intent-updated");

    await PaymentLink.updateMany(
      {
        tenantId,
        paymentId: pending._id,
        status: { $in: OPEN_LINK_STATUSES },
      },
      { $set: { status: LinkStatus.EXPIRED } },
      { session },
    );
    gatewayTxFaultCheckpoint("terminalFailure:link-updated");

    if (failedIntent?.schemeId) {
      await Scheme.updateOne(
        { _id: failedIntent.schemeId, tenantId },
        { $inc: { positionVersion: 1, version: 1 } },
        { session },
      );
    }
    gatewayTxFaultCheckpoint("terminalFailure:scheme-updated");

    await OutboxEvent.create(
      [
        {
          tenantId,
          topic: "payment.gateway.failed",
          key: pending._id,
          payload: {
            paymentId: pending._id,
            customerId: pending.customerId,
            schemeId: pending.schemeId,
            branchId: pending.branchId,
            reference,
            transactionId,
          },
        },
      ],
      { session },
    );
    gatewayTxFaultCheckpoint("terminalFailure:outbox-created");

    await writeAudit({
      req: {
        auth: { id: "phonepe", tenantId, type: "WEBHOOK" },
        headers: {},
        ip: "provider",
      },
      action: "PAYMENT_GATEWAY_FAILED",
      entityType: AuditEntityType.PAYMENT,
      entityId: pending._id,
      after: pending.toObject(),
      actorType: "WEBHOOK",
      session,
    });
    gatewayTxFaultCheckpoint("terminalFailure:audit-written");

    return { paymentId: pending._id, intentId: failedIntent?._id };
  };

  if (externalSession) return run(externalSession);
  return withTransaction(run);
}
