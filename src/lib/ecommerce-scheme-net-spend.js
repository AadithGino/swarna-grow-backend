import { ClosureType, RedemptionMode, ValueBasis } from "../constants/enums.js";
import { EcommerceSchemeReservation } from "../models/index.js";
import { getSchemePurchaseEntitlement } from "../services/ecommerce-scheme-reservation.service.js";
import { moneyRef, weightRef } from "./money.js";

export function netReservationUnits(row) {
  if (!row || row.status === "RELEASED") return 0;
  return Math.max(0, Number(row.units ?? 0) - Number(row.restoredUnits ?? 0));
}

export async function loadSchemeReservations(tenantId, schemeId, session) {
  const query = EcommerceSchemeReservation.find({
    tenantId,
    schemeId,
    status: { $in: ["HELD", "CONSUMED"] },
  }).lean();
  return session ? query.session(session) : query;
}

export async function loadReservationsByOrderIds(tenantId, orderIds, session) {
  const ids = [...new Set(orderIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const query = EcommerceSchemeReservation.find({
    tenantId,
    orderId: { $in: ids },
  }).lean();
  const rows = await (session ? query.session(session) : query);
  return new Map(rows.map((row) => [String(row.orderId), row]));
}

/** Summarize HELD + net CONSUMED units for a scheme (reservation truth). */
export function aggregateReservationNetSpend(reservations, basisHint = "CASH_VALUE") {
  const rows = Array.isArray(reservations) ? reservations : [];
  let heldUnits = 0;
  let consumedNetUnits = 0;
  let basis = basisHint;
  for (const row of rows) {
    const net = netReservationUnits(row);
    if (net <= 0) continue;
    basis = row.basis ?? basis;
    if (row.status === "HELD") heldUnits += net;
    else if (row.status === "CONSUMED") consumedNetUnits += net;
  }
  return { basis, heldUnits, consumedNetUnits, totalEncumberedUnits: heldUnits + consumedNetUnits };
}

/**
 * Remaining shop spendable units for a matured scheme (matches checkout quotes).
 * Returns null when scheme purchase is not configured or scheme not matured.
 */
export async function computeSchemeOnlineRemainder({
  tenantId,
  schemeId,
  customerId,
  settlementPaise,
  goldWeightMg,
  benefitWeightMg,
  planSnapshot,
  session,
}) {
  const rules = planSnapshot?.schemePurchaseRules;
  const redemptionRules = planSnapshot?.redemptionRules ?? {};
  if (!rules || !redemptionRules.allowedModes?.includes(RedemptionMode.PURCHASE_ADJUSTMENT)) {
    return null;
  }
  const spend = aggregateReservationNetSpend(await loadSchemeReservations(tenantId, schemeId, session));
  const basis = spend.basis ?? (rules.settlementBases?.includes("CASH_VALUE") ? "CASH_VALUE" : "GOLD_WEIGHT");
  const balance =
    basis === "GOLD_WEIGHT"
      ? Math.max(0, Number(goldWeightMg ?? 0) + Number(benefitWeightMg ?? 0))
      : Math.max(0, Number(settlementPaise ?? 0));
  const entitled = await getSchemePurchaseEntitlement({
    tenantId,
    schemeId,
    balance,
    basis,
    waiverCapPaise: rules.waiverCapPaise,
    session,
  });
  const availableUnits = Math.max(0, entitled.balance ?? 0);
  const netConsumed = spend.consumedNetUnits;
  const reserved = spend.heldUnits;
  return {
    basis,
    grossSettlementUnits: balance,
    availableUnits,
    reservedUnits: reserved,
    consumedNetUnits: netConsumed,
    availableLabel:
      basis === "GOLD_WEIGHT"
        ? (availableUnits > 0 ? weightRef(availableUnits).weightDisplay : "Fully used for shop")
        : (availableUnits > 0 ? moneyRef(availableUnits).amountDisplay : "Fully used for shop"),
    reservedLabel:
      reserved > 0
        ? (basis === "GOLD_WEIGHT"
          ? `${weightRef(reserved).weightDisplay} reserved for shop orders in progress`
          : `${moneyRef(reserved).amountDisplay} reserved for shop orders in progress`)
        : null,
    consumedLabel:
      netConsumed > 0
        ? (basis === "GOLD_WEIGHT"
          ? `${weightRef(netConsumed).weightDisplay} used online (after returns)`
          : `${moneyRef(netConsumed).amountDisplay} used online (after returns)`)
        : null,
  };
}

export async function buildSchemeOnlineEncumbranceSummary({
  tenantId,
  scheme,
  settlementPaise,
  goldWeightMg,
  benefitWeightMg,
  session,
}) {
  const showForStatus = new Set(["MATURED", "REDEEMED"]);
  if (!scheme?.planSnapshot?.schemePurchaseRules || !showForStatus.has(scheme.status)) return null;
  const reservations = await loadSchemeReservations(tenantId, scheme._id, session);
  const agg = aggregateReservationNetSpend(reservations);
  if (agg.totalEncumberedUnits <= 0) return null;
  const remainder = await computeSchemeOnlineRemainder({
    tenantId,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    settlementPaise,
    goldWeightMg,
    benefitWeightMg,
    planSnapshot: scheme.planSnapshot,
    session,
  });
  const lines = [];
  if (agg.consumedNetUnits > 0) {
    lines.push(
      agg.basis === "GOLD_WEIGHT"
        ? `${weightRef(agg.consumedNetUnits).weightDisplay} applied to completed online orders (net of returns).`
        : `${moneyRef(agg.consumedNetUnits).amountDisplay} applied to completed online orders (net of returns).`,
    );
  }
  if (agg.heldUnits > 0) {
    lines.push(
      agg.basis === "GOLD_WEIGHT"
        ? `${weightRef(agg.heldUnits).weightDisplay} reserved for shop orders awaiting fulfilment — not yet deducted from payout quotes.`
        : `${moneyRef(agg.heldUnits).amountDisplay} reserved for shop orders awaiting fulfilment — not yet deducted from payout quotes.`,
    );
  }
  if (remainder?.availableUnits > 0) {
    lines.push(`${remainder.availableLabel} still available for online shop checkout.`);
  } else if (remainder && agg.consumedNetUnits > 0 && agg.heldUnits === 0) {
    lines.push("No scheme balance remains after online shop use.");
  }
  return {
    basis: agg.basis,
    heldUnits: agg.heldUnits,
    consumedNetUnits: agg.consumedNetUnits,
    availableUnits: remainder?.availableUnits,
    summaryLines: lines,
  };
}

/** True when matured scheme has no shop remainder and no active holds after online use. */
export async function schemeFullySettledViaOnlineShop({
  tenantId,
  schemeId,
  customerId,
  settlementPaise,
  goldWeightMg,
  benefitWeightMg,
  planSnapshot,
  valueBasis,
  session,
}) {
  const remainder = await computeSchemeOnlineRemainder({
    tenantId,
    schemeId,
    customerId,
    settlementPaise,
    goldWeightMg,
    benefitWeightMg,
    planSnapshot,
    session,
  });
  if (!remainder) return false;
  if (remainder.reservedUnits > 0) return false;
  if (remainder.consumedNetUnits <= 0) return false;
  if (valueBasis === ValueBasis.CASH) {
    return remainder.availableUnits <= 0 && Number(settlementPaise ?? 0) > 0;
  }
  return remainder.availableUnits <= 0;
}

export const MATURITY_CLOSURE_TYPE = ClosureType.MATURITY_REDEMPTION;