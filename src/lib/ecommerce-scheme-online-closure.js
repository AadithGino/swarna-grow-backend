import { AuditEntityType, ClosureType, RedemptionMode, RedemptionStatus, SchemeStatus } from "../constants/enums.js";
import { OutboxEvent, Redemption, Scheme } from "../models/index.js";
import { settlementPreview } from "../services/redemption.service.js";
import { writeAudit } from "../services/audit.service.js";
import { aggregateReservationNetSpend, loadSchemeReservations } from "./ecommerce-scheme-net-spend.js";

const OPEN_REDEMPTION = [
  RedemptionStatus.REQUESTED,
  RedemptionStatus.PENDING_APPROVAL,
  RedemptionStatus.APPROVED,
];

/**
 * After shop delivery consumes the hold, mark the scheme REDEEMED when no balance remains.
 * Does not write a ledger REDEMPTION_DEBIT (ecommerce path; reservation is source of truth).
 */
export async function maybeCloseSchemeAfterOnlineFulfillment({
  order,
  session,
  actorId,
  reqLike,
}) {
  const purchase = order.financialSnapshot?.schemePurchase;
  if (!purchase?.schemeId) return false;

  const scheme = await Scheme.findOne({
    _id: purchase.schemeId,
    tenantId: order.tenantId,
    status: SchemeStatus.MATURED,
  }).session(session);
  if (!scheme) return false;

  const otherOpen = await Redemption.exists({
    tenantId: order.tenantId,
    schemeId: scheme._id,
    status: { $in: OPEN_REDEMPTION },
    "modeDetails.ecommerceOrderId": { $ne: order._id },
  }).session(session);
  if (otherOpen) return false;

  const reservations = await loadSchemeReservations(order.tenantId, scheme._id, session);
  if (aggregateReservationNetSpend(reservations).heldUnits > 0) return false;

  const preview = await settlementPreview(
    {
      auth: { tenantId: order.tenantId, id: order.customerId, type: "CUSTOMER" },
      params: { schemeId: scheme._id },
      body: { mode: RedemptionMode.CASH },
      scope: { tenantId: order.tenantId },
      query: {},
    },
    ClosureType.MATURITY_REDEMPTION,
  );

  const settledOnline =
    Number(preview.settlementPaise ?? 0) <= 0
    && preview.blockers?.some((row) => row.code === "SCHEME_SETTLED_VIA_ONLINE_SHOP");
  const noCashLeft = Number(preview.settlementPaise ?? 0) <= 0;
  if (!settledOnline && !noCashLeft) return false;
  if (aggregateReservationNetSpend(reservations).consumedNetUnits <= 0) return false;

  const before = scheme.toObject();
  scheme.status = SchemeStatus.REDEEMED;
  scheme.version += 1;
  await scheme.save({ session });

  const auditReq = reqLike ?? {
    auth: { id: actorId, tenantId: order.tenantId, type: "TENANT_USER" },
    scope: { tenantId: order.tenantId },
    headers: {},
    ip: "127.0.0.1",
  };
  await writeAudit({
    req: auditReq,
    action: "SCHEME_REDEEMED",
    entityType: AuditEntityType.SCHEME,
    entityId: scheme._id,
    before,
    after: scheme.toObject(),
    metadata: { orderId: order._id, closurePath: "ONLINE_SHOP_FULL" },
    session,
  });
  await OutboxEvent.create(
    [{
      tenantId: scheme.tenantId,
      topic: "scheme.closed",
      key: `${scheme._id}:ONLINE_SHOP`,
      payload: {
        schemeId: scheme._id,
        customerId: scheme.customerId,
        branchId: scheme.branchId,
        closureType: ClosureType.MATURITY_REDEMPTION,
        schemeStatus: scheme.status,
        enrollmentNumber: scheme.enrollmentNumber,
        orderId: order._id,
      },
    }],
    { session },
  );
  return true;
}