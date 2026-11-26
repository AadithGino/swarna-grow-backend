import { LedgerEntryType } from "../constants/enums.js";
import { EcommerceSchemeReservation, LedgerEntry, Redemption, Scheme } from "../models/index.js";
import { createId } from "./ids.js";
import { netReservationUnits } from "./ecommerce-scheme-net-spend.js";
import { nextSchemeLedgerSequence } from "../services/sequence.service.js";

/** REDEMPTION_DEBIT rows created when an online shop order is consumed (delivery / pickup). */
export function sumEcommerceRedemptionLedgerDebits(ledgerEntries) {
  let amountPaise = 0;
  let weightMg = 0;
  for (const row of ledgerEntries ?? []) {
    if (row.type !== LedgerEntryType.REDEMPTION_DEBIT) continue;
    const meta = row.metadata ?? {};
    if (meta.source === "ONLINE_SHOP" || meta.ecommerceOrderId) {
      amountPaise += Number(row.amountPaise ?? 0);
      weightMg += Number(row.weightMg ?? 0);
    }
  }
  return { amountPaise, weightMg };
}

/** Idempotent: one debit per linked ecommerce redemption when the reservation is consumed. */
export async function recordOnlineShopRedemptionLedgerDebit({
  tenantId,
  order,
  session,
  actorId,
}) {
  const purchase = order.financialSnapshot?.schemePurchase;
  if (!purchase?.redemptionId || !purchase?.schemeId) return false;

  const exists = await LedgerEntry.exists({
    tenantId,
    schemeId: purchase.schemeId,
    redemptionId: purchase.redemptionId,
    type: LedgerEntryType.REDEMPTION_DEBIT,
  }).session(session);
  if (exists) return false;

  const redemption = await Redemption.findOne({
    _id: purchase.redemptionId,
    tenantId,
    status: "COMPLETED",
  }).session(session).lean();
  if (!redemption) return false;

  const reservation = purchase.reservationId
    ? await EcommerceSchemeReservation.findOne({
      _id: purchase.reservationId,
      tenantId,
      orderId: order._id,
      status: "CONSUMED",
    }).session(session).lean()
    : null;
  const netUnits = reservation ? netReservationUnits(reservation) : 0;
  if (netUnits <= 0) return false;

  const scheme = await Scheme.findOne({ _id: purchase.schemeId, tenantId })
    .select("branchId customerId")
    .session(session)
    .lean();
  if (!scheme) return false;

  const basis = reservation?.basis ?? purchase.basis ?? "CASH_VALUE";
  const amountPaise = basis === "CASH_VALUE"
    ? netUnits
    : Number(redemption.settlementPaise ?? purchase.appliedPaise ?? 0);
  const weightMg = basis === "GOLD_WEIGHT" ? netUnits : undefined;

  const sequence = await nextSchemeLedgerSequence(tenantId, purchase.schemeId, session);
  await LedgerEntry.create(
    [{
      _id: createId("ledger"),
      tenantId,
      branchId: scheme.branchId,
      schemeId: purchase.schemeId,
      customerId: scheme.customerId,
      redemptionId: purchase.redemptionId,
      type: LedgerEntryType.REDEMPTION_DEBIT,
      sequence,
      amountPaise: Math.max(0, amountPaise),
      weightMg: weightMg > 0 ? weightMg : undefined,
      actorType: actorId ? "USER" : "SYSTEM",
      actorId: actorId ?? "system",
      description: "Online shop purchase completed",
      metadata: {
        ecommerceOrderId: order._id,
        orderNumber: order.orderNumber ?? undefined,
        source: "ONLINE_SHOP",
      },
    }],
    { session },
  );
  return true;
}