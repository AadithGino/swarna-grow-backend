import { EcommerceSchemeReservation, Redemption, Scheme } from "../models/index.js";
import { errors } from "../lib/app-error.js";
import { addPaise } from "../lib/ecommerce-exact-money.js";
import { allocateSchemeBenefit, calculateSchemeReturn, remainingSchemeEntitlement, returnedSchemeBenefitUnits } from "../lib/ecommerce-scheme-reservation-accounting.js";
import { createId } from "../lib/ids.js";
import { OPEN_REDEMPTION_STATUSES, settlementPreview, assertRedemptionKyc } from "./redemption.service.js";

function requireTransaction(session) {
  if (!session?.inTransaction()) throw new TypeError("Scheme reservations require the caller's order transaction.");
}

export async function getSchemePurchaseEntitlement({ tenantId, schemeId, balance, basis, waiverCapPaise, session }) {
  const query = EcommerceSchemeReservation.find({ tenantId, schemeId, status: { $in: ["HELD", "CONSUMED"] } })
    .lean();
  const reservations = await (session ? query.session(session) : query);
  const entitled = remainingSchemeEntitlement({ balance, basis, waiverCapPaise, reservations });
  let usedBenefitUnits = 0;
  for (const row of reservations) {
    const lines = await reservationLinesWithBenefit(row, session);
    for (const line of lines) {
      usedBenefitUnits = addPaise(usedBenefitUnits, line.benefitUnits -
        returnedSchemeBenefitUnits(line, line.returnedQuantity ?? 0));
    }
  }
  return { ...entitled, usedBenefitUnits };
}

async function reservationLinesWithBenefit(row, session) {
  if (row.lines.every((line) => line.benefitUnits != null)) return row.lines;
  const query = Redemption.findOne({
    tenantId: row.tenantId, schemeId: row.schemeId, "modeDetails.schemeReservationId": row._id,
  }).select("benefitPaise benefitWeightMg").lean();
  const linked = await (session ? query.session(session) : query);
  const units = row.basis === "GOLD_WEIGHT" ? linked?.benefitWeightMg : linked?.benefitPaise;
  return allocateSchemeBenefit(row.lines, Math.min(row.units, units ?? 0));
}

/** Use a server-calculated allocation within the same transaction that creates the order. */
export async function reserveSchemeForOrder({ tenantId, customerId, schemeId, schemeVersion, orderId,
  basis, balance, waiverCapPaise, lines, session }) {
  requireTransaction(session);
  const previous = await EcommerceSchemeReservation.findOne({ tenantId, orderId }).session(session);
  if (previous) throw errors.conflict("SCHEME_RESERVATION_EXISTS", "This order already has a scheme reservation.");
  const scheme = await Scheme.findOneAndUpdate({
    _id: schemeId, tenantId, customerId, version: schemeVersion, status: "MATURED",
  }, { $inc: { version: 1 } }, { session });
  if (!scheme || await Redemption.exists({ tenantId, schemeId,
    status: { $in: OPEN_REDEMPTION_STATUSES } }).session(session)) {
    throw errors.conflict("SCHEME_REDEMPTION_CHANGED", "This scheme changed or has a redemption in progress.");
  }
  const units = lines.reduce((sum, line) => addPaise(sum, line.schemeUnits), 0);
  const waiverPaise = lines.reduce((sum, line) => addPaise(sum, line.waiverPaise), 0);
  const available = await getSchemePurchaseEntitlement({ tenantId, schemeId, balance, basis, waiverCapPaise, session });
  if (!units || units > available.balance || (available.waiverCapPaise != null && waiverPaise > available.waiverCapPaise)) {
    throw errors.conflict("SCHEME_RESERVATION_INSUFFICIENT", "Refresh the quote because the scheme balance or waiver has changed.");
  }
  const [row] = await EcommerceSchemeReservation.create([{
    tenantId, customerId, schemeId, orderId, basis, units, balanceAtReservation: balance, schemeVersionAtReservation: schemeVersion + 1, waiverPaise, lines, status: "HELD",
  }], { session });
  return row;
}

export async function resolveSchemeOrderHold({ tenantId, orderId, status, session, reservationId }) {
  requireTransaction(session);
  if (!["CONSUMED", "RELEASED"].includes(status)) throw new TypeError("Invalid scheme hold resolution.");
  const row = await EcommerceSchemeReservation.findOne({ tenantId, orderId }).session(session);
  if (reservationId && row?._id !== reservationId) throw errors.notFound("Linked scheme reservation");
  if (!row || row.status === status) return row;
  if (row.status !== "HELD") throw errors.conflict("SCHEME_HOLD_ALREADY_RESOLVED", "This hold has already been resolved.");
  row.status = status;
  return row.save({ session });
}

export async function updateOrderRedemption(order, status, session, actorId) {
  const purchase = order.financialSnapshot?.schemePurchase;
  if (!purchase?.redemptionId) return;
  const from = status === "APPROVED" ? ["REQUESTED"]
    : status === "COMPLETED" ? ["APPROVED"] : ["REQUESTED", "APPROVED"];
  const updated = await Redemption.updateOne({
    _id: purchase.redemptionId, tenantId: order.tenantId,
    "modeDetails.ecommerceOrderId": order._id, status: { $in: from },
  }, { $set: {
    status,
    ...(status === "APPROVED" ? { approvedAt: new Date(), approvedBy: actorId } : {}),
    ...(status === "COMPLETED" ? { completedAt: new Date(), completedBy: actorId } : {}),
  }, $inc: { version: 1 } }, { session });
  if (!updated.modifiedCount) throw errors.conflict("SCHEME_ORDER_REDEMPTION_CHANGED", "The linked redemption has changed.");
}

export async function assertLinkedSchemeBacking(order, session) {
  const purchase = order.financialSnapshot?.schemePurchase;
  if (!purchase) return;
  requireTransaction(session);
  const hold = await EcommerceSchemeReservation.findOne({
    _id: purchase.reservationId, tenantId: order.tenantId, orderId: order._id,
    schemeId: purchase.schemeId, customerId: order.customerId, status: "HELD",
  }).session(session).lean();
  const invalid = () => errors.conflict("SCHEME_BACKING_CHANGED",
    "The backing scheme changed. Reconcile the purchase before continuing.");
  if (!hold) throw invalid();
  const scheme = await Scheme.findOneAndUpdate({
    _id: hold.schemeId, tenantId: hold.tenantId, customerId: hold.customerId, status: "MATURED",
  }, { $set: { ecommerceRedemptionFence: createId("fence") } }, { session, new: true, strict: false });
  if (!scheme) throw invalid();
  await assertRedemptionKyc({ auth: { tenantId: hold.tenantId } }, hold.customerId, { session });
  const preview = await settlementPreview({
    auth: { type: "CUSTOMER", tenantId: hold.tenantId, id: hold.customerId },
    params: { schemeId: hold.schemeId }, body: { mode: "PURCHASE_ADJUSTMENT" },
  }, "MATURITY_REDEMPTION", { valuationDateYmd: purchase.valuationRateEffectiveDate });
  const balance = hold.basis === "GOLD_WEIGHT"
    ? (preview.goldWeightMg ?? 0) + (preview.benefitWeightMg ?? 0) : preview.settlementPaise;
  const rows = await EcommerceSchemeReservation.find({
    tenantId: hold.tenantId, schemeId: hold.schemeId, status: { $in: ["HELD", "CONSUMED"] },
  }).session(session).lean();
  const used = rows.reduce((total, row) => addPaise(total, row.units - (row.restoredUnits ?? 0)), 0);
  if (!preview.eligible || balance < used) throw invalid();
}

export async function settleLinkedOrderHold(order, status, session, actorId) {
  const purchase = order.financialSnapshot?.schemePurchase;
  if (!purchase) return;
  if (!purchase.reservationId || (status === "CONSUMED" && purchase.approvalStatus !== "APPROVED")) {
    throw errors.business("SCHEME_PURCHASE_NOT_APPROVED", "Approve the linked scheme purchase before settling the order.");
  }
  if (status === "CONSUMED") await assertLinkedSchemeBacking(order, session);
  await resolveSchemeOrderHold({ tenantId: order.tenantId, orderId: order._id,
    reservationId: purchase.reservationId, status, session });
  await updateOrderRedemption(order, status === "CONSUMED" ? "COMPLETED" : "REJECTED", session, actorId);
}

export async function quoteSchemeOrderReturn({ order, items, session }) {
  const reservationId = order.financialSnapshot?.schemePurchase?.reservationId;
  if (!reservationId) return null;
  const row = await EcommerceSchemeReservation.findOne({
    _id: reservationId, tenantId: order.tenantId, orderId: order._id, status: "CONSUMED",
  }).session(session).lean();
  if (!row) throw errors.notFound("Consumed scheme reservation");
  return calculateSchemeReturn(await reservationLinesWithBenefit(row, session), items);
}

export async function restoreSchemeOrderReturn({ tenantId, orderId, reference, items, session }) {
  requireTransaction(session);
  if (!reference) throw new TypeError("A return reference is required.");
  const row = await EcommerceSchemeReservation.findOne({ tenantId, orderId, status: "CONSUMED" }).session(session);
  if (!row) throw errors.notFound("Consumed scheme reservation");
  const prior = row.returns.find((entry) => entry.reference === reference);
  if (prior) {
    if (JSON.stringify(prior.items) !== JSON.stringify(items)) {
      throw errors.conflict("SCHEME_RETURN_REFERENCE_REUSED", "This return reference already has different items.");
    }
    return prior;
  }
  const { lines, ...restoration } = calculateSchemeReturn(await reservationLinesWithBenefit(row.toObject(), session), items);
  row.lines = lines;
  row.restoredUnits = addPaise(row.restoredUnits, restoration.restoredUnits);
  row.restoredWaiverPaise = addPaise(row.restoredWaiverPaise, restoration.restoredWaiverPaise);
  row.returns.push({ reference, items, ...restoration });
  await row.save({ session });
  return restoration;
}
