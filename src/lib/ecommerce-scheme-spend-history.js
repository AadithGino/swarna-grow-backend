import { RedemptionMode, RedemptionStatus } from "../constants/enums.js";
import { moneyRef } from "./money.js";
import { EcommerceOrder, Redemption } from "../models/index.js";
import { classifySchemeEcommerceSpend } from "./ecommerce-scheme-spend-classify.js";
import { loadReservationsByOrderIds, netReservationUnits } from "./ecommerce-scheme-net-spend.js";

const TRACKED = [
  RedemptionStatus.REQUESTED,
  RedemptionStatus.PENDING_APPROVAL,
  RedemptionStatus.APPROVED,
  RedemptionStatus.COMPLETED,
  RedemptionStatus.REJECTED,
];

function formatApplied({ basis, appliedPaise, appliedWeightMg }) {
  if (basis === "GOLD_WEIGHT" && appliedWeightMg > 0) {
    return { label: `${(appliedWeightMg / 1000).toFixed(3)} g gold`, appliedWeightMg };
  }
  return { label: moneyRef(appliedPaise).amountDisplay, appliedPaise };
}

function formatRemaining({ basis, remaining }) {
  if (remaining == null || remaining <= 0) return null;
  if (basis === "GOLD_WEIGHT") {
    return { label: `${(remaining / 1000).toFixed(3)} g left after this order`, remainingWeightMg: remaining };
  }
  return { label: `${moneyRef(remaining).amountDisplay} left in scheme after this order`, remainingPaise: remaining };
}

/** Completed shop uses only (excludes expired / rejected / in-flight holds). */
export async function listSchemeEcommerceSpend(tenantId, schemeId) {
  const grouped = await listSchemeEcommerceSpendForSchemes(tenantId, [schemeId]);
  const all = grouped.get(String(schemeId)) ?? [];
  return all.filter((row) => row.countsAsSpend === true);
}

/** Every linked shop checkout (completed, pending, failed), newest first. */
export async function listSchemeEcommerceSpendAttempts(tenantId, schemeId) {
  const grouped = await listSchemeEcommerceSpendForSchemes(tenantId, [schemeId]);
  return grouped.get(String(schemeId)) ?? [];
}

async function fetchSchemeEcommerceSpendRedemptions(tenantId, schemeIds) {
  if (!schemeIds.length) return [];
  return Redemption.find({
    tenantId,
    schemeId: { $in: schemeIds },
    mode: RedemptionMode.PURCHASE_ADJUSTMENT,
    "modeDetails.ecommerceOrderId": { $exists: true, $ne: "" },
    status: { $in: TRACKED },
  })
    .sort({ requestedAt: -1, createdAt: -1 })
    .select(
      "_id schemeId status settlementPaise weightMg requestedAt completedAt modeDetails",
    )
    .lean();
}

/** Batch load spend rows grouped by scheme id (newest first per scheme). */
export async function listSchemeEcommerceSpendForSchemes(tenantId, schemeIds) {
  const ids = [...new Set(schemeIds.map((id) => String(id)).filter(Boolean))];
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const redemptions = await fetchSchemeEcommerceSpendRedemptions(tenantId, ids);
  if (!redemptions.length) return out;
  const orderIds = [
    ...new Set(
      redemptions
        .map((row) => row.modeDetails?.ecommerceOrderId)
        .filter(Boolean),
    ),
  ];
  const orders = await EcommerceOrder.find({
    _id: { $in: orderIds },
    tenantId,
  })
    .select("orderNumber status financialSnapshot.schemePurchase createdAt")
    .lean();
  const orderById = new Map(orders.map((row) => [String(row._id), row]));
  const reservationByOrder = await loadReservationsByOrderIds(tenantId, orderIds);

  for (const row of redemptions) {
    const orderId = String(row.modeDetails.ecommerceOrderId);
    const order = orderById.get(orderId);
    const snap = order?.financialSnapshot?.schemePurchase ?? {};
    const basis = snap.basis ?? "CASH_VALUE";
    const appliedPaise = snap.appliedPaise ?? row.settlementPaise ?? 0;
    const appliedWeightMg = snap.applied ?? row.weightMg ?? 0;
    const reservation = reservationByOrder.get(orderId);
    const spendMeta = classifySchemeEcommerceSpend(row, order);
    const netUnits = reservation ? netReservationUnits(reservation) : 0;
    const netAppliedPaise = basis === "CASH_VALUE" && spendMeta.countsAsSpend ? netUnits : appliedPaise;
    const netAppliedWeightMg = basis === "GOLD_WEIGHT" && spendMeta.countsAsSpend ? netUnits : appliedWeightMg;
    const countsAsSpend = spendMeta.countsAsSpend && netUnits > 0;
    const remaining = snap.remaining;
    const applied = formatApplied({
      basis,
      appliedPaise: countsAsSpend ? netAppliedPaise : appliedPaise,
      appliedWeightMg: countsAsSpend ? netAppliedWeightMg : appliedWeightMg,
    });
    const remainingFmt = formatRemaining({ basis, remaining });
    const entry = {
      id: row._id,
      redemptionId: row._id,
      orderId,
      orderNumber: order?.orderNumber ?? null,
      orderStatus: order?.status ?? null,
      redemptionStatus: row.status,
      occurredAt: row.completedAt ?? row.requestedAt ?? order?.createdAt,
      basis,
      appliedPaise: countsAsSpend ? netAppliedPaise : appliedPaise,
      appliedWeightMg: basis === "GOLD_WEIGHT"
        ? (countsAsSpend ? netAppliedWeightMg : appliedWeightMg)
        : undefined,
      grossAppliedPaise: appliedPaise,
      grossAppliedWeightMg: basis === "GOLD_WEIGHT" ? appliedWeightMg : undefined,
      topUpPaise: snap.topUpPaise ?? 0,
      grossOrderPaise: snap.grossPaise ?? null,
      remainingAfterOrder: remaining ?? null,
      appliedLabel: applied.label,
      remainingLabel: spendMeta.countsAsSpend ? (remainingFmt?.label ?? null) : null,
      makingChargeWaivedPaise: snap.makingChargeWaivedPaise ?? 0,
      title: spendMeta.outcome === "COMPLETED" ? "Online shop purchase" : "Shop checkout attempt",
      countsAsSpend,
      outcome: spendMeta.outcome,
      outcomeLabel: spendMeta.outcomeLabel,
      showAppliedAsDeduction: countsAsSpend && spendMeta.showAppliedAsDeduction,
      description: spendMeta.countsAsSpend && remainingFmt
        ? `Used for order ${order?.orderNumber ?? orderId} · ${remainingFmt.label}`
        : `${order?.orderNumber ?? orderId} · ${spendMeta.outcomeLabel}`,
    };
    const key = String(row.schemeId);
    const list = out.get(key) ?? [];
    list.push(entry);
    out.set(key, list);
  }
  return out;
}