import { createId } from "../lib/ids.js";
import { errors } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import {
  EcommerceOrderEventType,
  EcommercePaymentAttemptOperationalStatus,
  EcommercePaymentAttemptStatus,
} from "../constants/enums.js";
import {
  EcommerceOrderEvent,
  EcommercePaymentAttempt,
  Tenant,
} from "../models/index.js";
import { phonePeProvider, resolvePhonePeCredentials } from "../integrations/phonepe.provider.js";
import {
  claimEcommercePaymentAttemptForReconcile,
  reconcileEcommercePaymentAttempt,
} from "./ecommerce-payment-reconcile.service.js";
export async function getAdminPaymentAttemptProviderStatus(req) {
  const attempt = await EcommercePaymentAttempt.findOne({
    _id: req.params.paymentAttemptId,
    tenantId: req.auth.tenantId,
    orderId: req.params.orderId,
  }).lean();
  if (!attempt) throw errors.notFound("Payment attempt");
  const tenant = await Tenant.findById(req.auth.tenantId).select("+integrationSecrets").lean();
  const credentials = resolvePhonePeCredentials(tenant);
  const merchantOrderId = attempt.merchantOrderId ?? attempt._id;
  const providerOrderId = attempt.providerOrderId ?? merchantOrderId;
  let providerStatus = null;
  let providerError = null;
  try {
    providerStatus = await phonePeProvider.getOrderStatus(
      providerOrderId,
      credentials,
      req.auth.tenantId,
    );
  } catch (error) {
    providerError = error?.message ?? String(error);
  }
  return {
    paymentAttemptId: attempt._id,
    orderId: attempt.orderId,
    merchantOrderId,
    providerOrderId,
    attemptStatus: attempt.status,
    operationalStatus: attempt.operationalStatus ?? null,
    providerStatus,
    providerError,
  };
}

export async function retryAdminPaymentAttemptReconcile(req) {
  const reason = String(req.body.reason ?? "").trim();
  if (!reason || reason.length < 8) {
    throw errors.validation([
      { field: "reason", message: "Reason of at least 8 characters is required for reconcile retry." },
    ]);
  }
  const attempt = await EcommercePaymentAttempt.findOne({
    _id: req.params.paymentAttemptId,
    tenantId: req.auth.tenantId,
    orderId: req.params.orderId,
  }).lean();
  if (!attempt) throw errors.notFound("Payment attempt");
  if (attempt.status !== EcommercePaymentAttemptStatus.INITIATED) {
    throw errors.business(
      "RECONCILE_NOT_APPLICABLE",
      "Only in-flight initiated attempts can be reconciled.",
    );
  }

  await EcommercePaymentAttempt.updateOne(
    { _id: attempt._id, tenantId: req.auth.tenantId },
    {
      $set: {
        operationalStatus: EcommercePaymentAttemptOperationalStatus.AWAITING_PROVIDER,
        gatewayReconcileNextAt: new Date(),
        gatewayReconcileLeaseOwner: null,
        gatewayReconcileLeaseExpiresAt: null,
      },
      $inc: { version: 1 },
    },
  );

  const claimed = await claimEcommercePaymentAttemptForReconcile(attempt._id);
  if (!claimed) {
    throw errors.conflict("RECONCILE_LEASE_BUSY", "Reconcile lease could not be acquired. Retry shortly.");
  }

  const result = await reconcileEcommercePaymentAttempt(claimed, {
    leaseOwner: claimed.gatewayReconcileLeaseOwner,
  });

  await EcommerceOrderEvent.create([
    {
      _id: createId("eoev"),
      tenantId: req.auth.tenantId,
      orderId: attempt.orderId,
      type: EcommerceOrderEventType.PAYMENT_RECONCILED,
      actorType: "STAFF",
      actorId: req.auth.id,
      payload: {
        paymentAttemptId: attempt._id,
        action: "RECONCILE_RETRY",
        reason,
        outcome: result.outcome ?? null,
      },
    },
  ]);

  return { outcome: result.outcome ?? "UNKNOWN", result };
}

export async function acknowledgeAdminPaymentAttemptOperational(req) {
  const resolution = String(req.body.resolution ?? "").trim();
  const reason = String(req.body.reason ?? "").trim();
  const evidenceNote = String(req.body.evidenceNote ?? "").trim();
  if (!["CONTINUE_AWAITING", "ESCALATE_REVIEW"].includes(resolution)) {
    throw errors.validation([
      { field: "resolution", message: "resolution must be CONTINUE_AWAITING or ESCALATE_REVIEW." },
    ]);
  }
  if (!reason || reason.length < 8) {
    throw errors.validation([{ field: "reason", message: "Reason of at least 8 characters is required." }]);
  }
  if (!evidenceNote || evidenceNote.length < 8) {
    throw errors.validation([
      { field: "evidenceNote", message: "Evidence note of at least 8 characters is required." },
    ]);
  }

  const attempt = await EcommercePaymentAttempt.findOne({
    _id: req.params.paymentAttemptId,
    tenantId: req.auth.tenantId,
    orderId: req.params.orderId,
  }).lean();
  if (!attempt) throw errors.notFound("Payment attempt");
  if (
    attempt.operationalStatus !== EcommercePaymentAttemptOperationalStatus.STUCK_RECONCILE
    && attempt.operationalStatus !== EcommercePaymentAttemptOperationalStatus.INITIATION_UNCERTAIN
  ) {
    throw errors.business("OPERATIONAL_ACK_NOT_APPLICABLE", "Attempt is not in an operator queue state.");
  }

  const nextOperational =
    resolution === "CONTINUE_AWAITING"
      ? EcommercePaymentAttemptOperationalStatus.AWAITING_PROVIDER
      : EcommercePaymentAttemptOperationalStatus.STUCK_RECONCILE;

  return withTransaction(async (session) => {
    const updated = await EcommercePaymentAttempt.findOneAndUpdate(
      {
        _id: attempt._id,
        tenantId: req.auth.tenantId,
        operationalStatus: attempt.operationalStatus,
      },
      {
        $set: {
          operationalStatus: nextOperational,
          gatewayReconcileNextAt: new Date(),
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    );
    if (!updated) throw errors.conflict("VERSION_CONFLICT", "Attempt changed elsewhere.");
    await EcommerceOrderEvent.create(
      [
        {
          _id: createId("eoev"),
          tenantId: req.auth.tenantId,
          orderId: attempt.orderId,
          type: EcommerceOrderEventType.PAYMENT_RECONCILED,
          actorType: "STAFF",
          actorId: req.auth.id,
          payload: {
            paymentAttemptId: attempt._id,
            resolution,
            reason,
            evidenceNote,
            note: "Operator acknowledgement — no payment or stock state changed.",
          },
        },
      ],
      { session },
    );
    return { paymentAttempt: updated.toObject() };
  });
}
