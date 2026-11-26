import { EcommerceSchemeReservation, EcommerceOrder, LedgerEntry } from "../models/index.js";
import { LedgerEntryType } from "../constants/enums.js";
import { netReservationUnits } from "./ecommerce-scheme-net-spend.js";

export async function findEcommerceSchemeLedgerBackfillCandidates(tenantId) {
  const filter = { status: "CONSUMED" };
  if (tenantId) filter.tenantId = tenantId;
  const reservations = await EcommerceSchemeReservation.find(filter).lean();
  const out = [];
  for (const row of reservations) {
    if (netReservationUnits(row) <= 0) continue;
    const order = await EcommerceOrder.findOne({ _id: row.orderId, tenantId: row.tenantId }).lean();
    if (!order?.financialSnapshot?.schemePurchase?.redemptionId) continue;
    const redemptionId = order.financialSnapshot.schemePurchase.redemptionId;
    const exists = await LedgerEntry.exists({
      tenantId: row.tenantId,
      schemeId: row.schemeId,
      redemptionId,
      type: LedgerEntryType.REDEMPTION_DEBIT,
    });
    if (exists) continue;
    out.push({ reservation: row, order, redemptionId });
  }
  return out;
}