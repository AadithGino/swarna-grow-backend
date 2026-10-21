import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { Customer, DigitalMetalCustomerRiskHold } from "../models/index.js";
import { assertTenantOwnsCustomerScope } from "./digital-metals.service.js";

async function findBlockingHold(tenantId, customerId, field, session = null) {
  let q = DigitalMetalCustomerRiskHold.findOne({
    tenantId,
    customerId,
    status: "ACTIVE",
    [field]: true,
  });
  if (session) q = q.session(session);
  return q.lean();
}

function throwIfRiskHold(active, message) {
  if (!active) return;
  throw new AppError(
    "DIGITAL_METALS_RISK_HOLD",
    message,
    409,
    {
      holdId: active._id,
      reasonCode: active.reasonCode,
      holdScope: active.holdScope,
      exposurePaise: active.exposurePaise,
    },
  );
}

export async function assertCustomerCanPlaceSell(tenantId, customerId) {
  throwIfRiskHold(
    await findBlockingHold(tenantId, customerId, "blocksSell"),
    "Sell trading is blocked pending financial exception review.",
  );
}

export async function assertCustomerCanPlaceRedemption(tenantId, customerId) {
  throwIfRiskHold(
    await findBlockingHold(tenantId, customerId, "blocksRedemption"),
    "Physical redemption is blocked pending financial exception review.",
  );
}

export async function assertCustomerCanPlaceSellInSession(session, tenantId, customerId) {
  throwIfRiskHold(
    await findBlockingHold(tenantId, customerId, "blocksSell", session),
    "Sell trading is blocked pending financial exception review.",
  );
}

export async function assertCustomerCanPlaceRedemptionInSession(session, tenantId, customerId) {
  throwIfRiskHold(
    await findBlockingHold(tenantId, customerId, "blocksRedemption", session),
    "Physical redemption is blocked pending financial exception review.",
  );
}

function resolveHoldFlags({ exceptionType, buyOrderStatus }) {
  const credited = buyOrderStatus === "CREDITED";
  const refundOnly =
    (exceptionType === "LATE_SUCCESS" || exceptionType === "DUPLICATE_PAYMENT") && !credited;
  if (refundOnly) {
    return {
      holdScope: "REFUND_CASE",
      blocksSell: false,
      blocksRedemption: false,
      reasonCode: "REFUND_EXPOSURE",
    };
  }
  if (exceptionType === "CHARGEBACK") {
    return {
      holdScope: "TRADING",
      blocksSell: true,
      blocksRedemption: true,
      reasonCode: "CHARGEBACK",
    };
  }
  return {
    holdScope: credited ? "TRADING" : "REFUND_CASE",
    blocksSell: credited,
    blocksRedemption: credited,
    reasonCode: "REFUND_EXPOSURE",
  };
}

/** Scoped hold per refund case; resolving one hold does not affect others. */
export async function ensureCustomerRiskHoldForPaymentException(
  session,
  {
    tenantId,
    customerId,
    exceptionType,
    exposurePaise,
    relatedBuyOrderId = null,
    relatedRefundCaseId = null,
    buyOrderStatus = null,
  },
) {
  if (!customerId) return null;
  const flags = resolveHoldFlags({ exceptionType, buyOrderStatus });
  const exposure = Math.max(0, Number(exposurePaise) || 0);
  const filter = relatedRefundCaseId
    ? { tenantId, relatedRefundCaseId, status: "ACTIVE" }
    : { tenantId, customerId, relatedBuyOrderId, status: "ACTIVE", holdScope: "REFUND_CASE" };
  const existing = await DigitalMetalCustomerRiskHold.findOne(filter).session(session);
  if (existing) {
    if (exposure > existing.exposurePaise) existing.exposurePaise = exposure;
    if (flags.blocksSell) existing.blocksSell = true;
    if (flags.blocksRedemption) existing.blocksRedemption = true;
    if (flags.reasonCode === "CHARGEBACK") existing.reasonCode = "CHARGEBACK";
    await existing.save({ session });
    return existing.toObject();
  }
  const created = (
    await DigitalMetalCustomerRiskHold.create(
      [
        {
          _id: createId("dmrh"),
          tenantId,
          customerId,
          status: "ACTIVE",
          reasonCode: flags.reasonCode,
          holdScope: flags.holdScope,
          blocksSell: flags.blocksSell,
          blocksRedemption: flags.blocksRedemption,
          exposurePaise: exposure,
          relatedBuyOrderId,
          relatedRefundCaseId,
          note: `Auto hold for payment exception ${exceptionType}.`,
        },
      ],
      { session },
    )
  )[0];
  return created.toObject();
}

export async function createCustomerRiskHold(req) {
  const customerId = req.params.customerId || req.body.customerId;
  if (!customerId) throw errors.validation([{ field: "customerId", message: "Required." }]);
  const hold = await DigitalMetalCustomerRiskHold.create({
    _id: createId("dmrh"),
    tenantId: req.auth.tenantId,
    customerId,
    status: "ACTIVE",
    reasonCode: req.body.reasonCode ?? "MANUAL",
    holdScope: "TRADING",
    blocksSell: req.body.blocksSell !== false,
    blocksRedemption: req.body.blocksRedemption !== false,
    exposurePaise: Number(req.body.exposurePaise ?? 0),
    unrecoverableMetalUg: Number(req.body.unrecoverableMetalUg ?? 0),
    relatedBuyOrderId: req.body.relatedBuyOrderId ?? null,
    relatedRefundCaseId: req.body.relatedRefundCaseId ?? null,
    note: String(req.body.note ?? "").slice(0, 2000),
    createdByUserId: req.auth.id,
  });
  return hold.toObject();
}

export async function resolveCustomerRiskHold(req) {
  const hold = await DigitalMetalCustomerRiskHold.findOne({
    _id: req.params.holdId,
    tenantId: req.auth.tenantId,
  });
  if (!hold) throw errors.notFound("Risk hold");
  if (hold.status === "RESOLVED") return hold.toObject();
  hold.status = "RESOLVED";
  hold.resolvedByUserId = req.auth.id;
  hold.resolvedAt = new Date();
  hold.resolutionNote = String(req.body.resolutionNote ?? "").slice(0, 2000);
  await hold.save();
  return hold.toObject();
}

export async function listAdminCustomerRiskHolds(req) {
  const customer = await Customer.findOne({
    _id: req.params.customerId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!customer) throw errors.notFound("Customer");
  assertTenantOwnsCustomerScope(req, customer);
  const filter = { tenantId: req.auth.tenantId, customerId: req.params.customerId };
  if (req.query.status) filter.status = req.query.status;
  const items = await DigitalMetalCustomerRiskHold.find(filter).sort({ createdAt: -1 }).limit(50).lean();
  return { items };
}
