import { ClosureType, RedemptionMode } from "../constants/enums.js";
import { moneyRef, weightRef } from "./money.js";
import {
  listSchemeEcommerceSpend,
  listSchemeEcommerceSpendAttempts,
  listSchemeEcommerceSpendForSchemes,
} from "./ecommerce-scheme-spend-history.js";
import { getSchemePurchaseEntitlement } from "../services/ecommerce-scheme-reservation.service.js";
import { settlementPreview, OPEN_REDEMPTION_STATUSES } from "../services/redemption.service.js";
import { Redemption } from "../models/index.js";
import { schemeHasOnlineAllocation } from "./ecommerce-scheme-online-use.js";

function weightLabel(mg) {
  if (!mg || mg <= 0) return null;
  return weightRef(mg).weightDisplay;
}

function paiseLabel(paise) {
  if (!paise || paise <= 0) return null;
  return moneyRef(paise).amountDisplay;
}

/** Roll up shop spend rows (excludes rejected purchase adjustments). */
export function aggregateSchemeEcommerceSpend(spendRows) {
  const rows = Array.isArray(spendRows) ? spendRows : [];
  let orderCount = 0;
  let totalAppliedPaise = 0;
  let totalAppliedWeightMg = 0;
  let basis = "CASH_VALUE";
  for (const row of rows) {
    if (row.countsAsSpend === false || row.redemptionStatus === "REJECTED") continue;
    orderCount += 1;
    basis = row.basis ?? basis;
    totalAppliedPaise += Number(row.appliedPaise ?? 0);
    if (row.basis === "GOLD_WEIGHT") {
      totalAppliedWeightMg += Number(row.appliedWeightMg ?? row.applied ?? 0);
    }
  }
  const usedLabel =
    basis === "GOLD_WEIGHT" && totalAppliedWeightMg > 0
      ? `${weightLabel(totalAppliedWeightMg)} used online`
      : totalAppliedPaise > 0
        ? `${paiseLabel(totalAppliedPaise)} used online`
        : orderCount > 0
          ? `${orderCount} shop order${orderCount === 1 ? "" : "s"}`
          : null;
  return {
    orderCount,
    basis,
    totalAppliedPaise,
    totalAppliedWeightMg: basis === "GOLD_WEIGHT" ? totalAppliedWeightMg : undefined,
    usedLabel,
  };
}

function pickShopBasis(planSnapshot, spendAggregate) {
  const rules = planSnapshot?.schemePurchaseRules;
  const allowed = rules?.settlementBases ?? [];
  if (spendAggregate?.orderCount && spendAggregate.basis) return spendAggregate.basis;
  if (allowed.includes("CASH_VALUE")) return "CASH_VALUE";
  if (allowed.includes("GOLD_WEIGHT")) return "GOLD_WEIGHT";
  return allowed[0] ?? "CASH_VALUE";
}

function availableLabel(basis, units) {
  if (units == null || units <= 0) return "Fully used for shop";
  return basis === "GOLD_WEIGHT"
    ? `${weightLabel(units)} left for shop`
    : `${paiseLabel(units)} left for shop`;
}

async function liveShopAvailable({ tenantId, customerId, schemeId, scheme, spendAggregate }) {
  const rules = scheme.planSnapshot?.schemePurchaseRules;
  const redemptionRules = scheme.planSnapshot?.redemptionRules ?? {};
  if (scheme.status !== "MATURED") return null;
  if (!redemptionRules.allowedModes?.includes(RedemptionMode.PURCHASE_ADJUSTMENT)) return null;
  if (!["ONLINE", "BOTH"].includes(rules?.channel)) return null;
  if (await Redemption.exists({ tenantId, schemeId, status: { $in: OPEN_REDEMPTION_STATUSES } })) {
    return { basis: spendAggregate.basis, availableUnits: 0, availableLabel: "Redemption in progress", showAvailable: true };
  }
  const req = {
    auth: { tenantId, id: customerId, type: "CUSTOMER" },
    params: { schemeId },
    query: {},
    body: { mode: RedemptionMode.PURCHASE_ADJUSTMENT },
  };
  const settlement = await settlementPreview(req, ClosureType.MATURITY_REDEMPTION);
  if (!settlement.eligible) return null;
  const basis = pickShopBasis(scheme.planSnapshot, spendAggregate);
  const balance =
    basis === "GOLD_WEIGHT"
      ? (settlement.goldWeightMg ?? 0) + (settlement.benefitWeightMg ?? 0)
      : settlement.settlementPaise ?? 0;
  const entitled = await getSchemePurchaseEntitlement({
    tenantId,
    schemeId,
    balance,
    basis,
    waiverCapPaise: rules?.waiverCapPaise,
  });
  const availableUnits = entitled.balance ?? 0;
  return {
    basis,
    settlementUnits: balance,
    availableUnits,
    availableLabel: availableLabel(basis, availableUnits),
    showAvailable: true,
  };
}

/**
 * Customer/admin snapshot: how much of a matured scheme went to the online shop and what remains spendable.
 */
export async function buildSchemeShopBalanceSummary({
  tenantId,
  customerId,
  schemeId,
  scheme,
  spendRows,
}) {
  const rows = spendRows ?? (await listSchemeEcommerceSpendAttempts(tenantId, schemeId));
  const used = aggregateSchemeEcommerceSpend(rows);
  const doc = scheme ?? { status: "ACTIVE" };
  let available = null;
  const hasSpend = used.orderCount > 0;
  const mayNeedAvailable =
    doc.status === "MATURED"
    && (hasSpend || (await schemeHasOnlineAllocation({ tenantId, schemeId })));
  if (mayNeedAvailable && customerId && doc.planSnapshot) {
    try {
      available = await liveShopAvailable({ tenantId, customerId, schemeId, scheme: doc, spendAggregate: used });
    } catch {
      available = null;
    }
  }
  if (!hasSpend && !available) return null;
  return {
    ...used,
    availableBasis: available?.basis,
    availableUnits: available?.availableUnits,
    availableLabel: available?.availableLabel ?? null,
    summaryLine:
      used.usedLabel && available?.availableLabel
        ? `${used.usedLabel} · ${available.availableLabel}`
        : used.usedLabel ?? available?.availableLabel ?? null,
  };
}

/** Batch summaries for home / customer scheme lists. */
export async function buildSchemeShopBalanceSummaries(tenantId, customerId, schemeDocs) {
  if (!schemeDocs?.length) return new Map();
  const schemeIds = schemeDocs.map((row) => row._id ?? row.id);
  const spendByScheme = await listSchemeEcommerceSpendForSchemes(tenantId, schemeIds);
  const out = new Map();
  await Promise.all(
    schemeDocs.map(async (scheme) => {
      const schemeId = String(scheme._id ?? scheme.id);
      const summary = await buildSchemeShopBalanceSummary({
        tenantId,
        customerId,
        schemeId,
        scheme,
        spendRows: spendByScheme.get(schemeId) ?? [],
      });
      if (summary) out.set(schemeId, summary);
    }),
  );
  return out;
}

export function aggregateCustomerShopBalanceSummaries(summaryMap) {
  let orderCount = 0;
  let usedPaise = 0;
  let usedWeightMg = 0;
  let availablePaise = 0;
  let availableWeightMg = 0;
  for (const summary of summaryMap.values()) {
    orderCount += summary.orderCount ?? 0;
    if (summary.basis === "GOLD_WEIGHT") {
      usedWeightMg += summary.totalAppliedWeightMg ?? 0;
      if (summary.availableBasis === "GOLD_WEIGHT") availableWeightMg += summary.availableUnits ?? 0;
    } else {
      usedPaise += summary.totalAppliedPaise ?? 0;
      if (summary.availableBasis !== "GOLD_WEIGHT") availablePaise += summary.availableUnits ?? 0;
    }
  }
  const parts = [];
  if (usedPaise > 0) parts.push(`${paiseLabel(usedPaise)} used online`);
  if (usedWeightMg > 0) parts.push(`${weightLabel(usedWeightMg)} used online`);
  if (availablePaise > 0) parts.push(`${paiseLabel(availablePaise)} left for shop`);
  if (availableWeightMg > 0) parts.push(`${weightLabel(availableWeightMg)} left for shop`);
  if (!parts.length && orderCount > 0) {
    parts.push(`${orderCount} shop order${orderCount === 1 ? "" : "s"} with scheme`);
  }
  return parts.length
    ? { orderCount, summaryLine: parts.join(" · "), usedPaise, usedWeightMg, availablePaise, availableWeightMg }
    : null;
}