import { ClosureType, RedemptionMode, ValueBasis } from "../constants/enums.js";
import { listSchemeEcommerceSpendAttempts } from "./ecommerce-scheme-spend-history.js";
import {
  aggregateReservationNetSpend,
  loadSchemeReservations,
} from "./ecommerce-scheme-net-spend.js";
import { moneyRef } from "./money.js";
import { sumEcommerceRedemptionLedgerDebits } from "./ecommerce-scheme-ledger-debit.js";

/**
 * Maturity previews: ledger may already include ONLINE_SHOP REDEMPTION_DEBIT (phase 8+).
 * Only subtract reservation net not yet on the ledger (legacy orders).
 */
export async function applyEcommerceSchemeToMaturitySettlementPreview({
  tenantId,
  scheme,
  closureType,
  settlementMode,
  isPremature,
  systemPolicyClosure,
  settlementPaise,
  goldWeightMg,
  benefitWeightMg,
  moneyField,
  ledgerEntries,
}) {
  if (
    isPremature
    || systemPolicyClosure
    || closureType !== ClosureType.MATURITY_REDEMPTION
    || !scheme?.planSnapshot?.schemePurchaseRules
    || settlementMode === RedemptionMode.PURCHASE_ADJUSTMENT
  ) {
    return null;
  }

  const [attempts, reservations] = await Promise.all([
    listSchemeEcommerceSpendAttempts(tenantId, scheme._id),
    loadSchemeReservations(tenantId, scheme._id),
  ]);
  const reserved = aggregateReservationNetSpend(reservations);
  const failed = attempts.filter((row) => row.outcome === "FAILED");
  const pending = attempts.filter((row) => row.outcome === "PENDING");

  const notes = [];
  for (const row of failed) {
    const ref = row.orderNumber ? `Order ${row.orderNumber}` : "A shop checkout";
    notes.push(
      `${ref} did not complete — ${row.outcomeLabel ?? "scheme balance was restored"}. This quote still includes that amount.`,
    );
  }
  for (const row of pending) {
    const ref = row.orderNumber ? `Order ${row.orderNumber}` : "A shop checkout";
    notes.push(
      `${ref} is reserved (${row.outcomeLabel ?? "pending"}). It is not deducted from this quote until the order finishes or is cancelled.`,
    );
  }

  const blockers = [];
  const extraLines = [];
  let nextSettlementPaise = settlementPaise;
  let nextGoldWeightMg = goldWeightMg;
  let nextBenefitWeightMg = benefitWeightMg;

  const usedPaise =
    scheme.valueBasis === ValueBasis.CASH && reserved.basis === "CASH_VALUE"
      ? reserved.consumedNetUnits
      : attempts.filter((row) => row.countsAsSpend).reduce((sum, row) => sum + Number(row.appliedPaise ?? 0), 0);
  const usedWeightMg =
    scheme.valueBasis === ValueBasis.GOLD_WEIGHT && reserved.basis === "GOLD_WEIGHT"
      ? reserved.consumedNetUnits
      : attempts.filter((row) => row.countsAsSpend).reduce(
        (sum, row) => sum + Number(row.appliedWeightMg ?? 0),
        0,
      );
  const heldPaise = reserved.basis === "CASH_VALUE" ? reserved.heldUnits : 0;
  const heldWeightMg = reserved.basis === "GOLD_WEIGHT" ? reserved.heldUnits : 0;
  const completedCount = attempts.filter((row) => row.countsAsSpend).length;
  const ledgerOnline = sumEcommerceRedemptionLedgerDebits(ledgerEntries);
  const legacyShopPaise = Math.max(0, usedPaise - ledgerOnline.amountPaise);
  const legacyShopWeightMg = Math.max(0, usedWeightMg - ledgerOnline.weightMg);

  if (ledgerOnline.amountPaise > 0) {
    notes.unshift(
      `${moneyRef(ledgerOnline.amountPaise).amountDisplay} is already on the passbook from completed online shop orders.`,
    );
  }

  if (scheme.valueBasis === ValueBasis.CASH && legacyShopPaise > 0 && nextSettlementPaise > 0) {
    const deduction = Math.min(legacyShopPaise, nextSettlementPaise);
    if (deduction > 0) {
      const orderLabel = completedCount === 1 && attempts.find((row) => row.countsAsSpend)?.orderNumber
        ? `Online shop — ${attempts.find((row) => row.countsAsSpend).orderNumber}`
        : `Online shop purchases (${completedCount || 1})`;
      extraLines.push({
        key: "ECOMMERCE_SCHEME_SPEND",
        label: orderLabel,
        amount: moneyField(deduction),
        sign: "-",
        note: "Net amount after returns, when the linked shop order was delivered or picked up.",
      });
      nextSettlementPaise -= deduction;
      if ((ledgerOnline.amountPaise + legacyShopPaise) < settlementPaise) {
        notes.unshift(
          `${moneyRef(ledgerOnline.amountPaise + legacyShopPaise).amountDisplay} used via online shop; remaining balance is what you can redeem.`,
        );
      }
    }
  } else if (scheme.valueBasis === ValueBasis.GOLD_WEIGHT && (legacyShopWeightMg > 0 || ledgerOnline.weightMg > 0)) {
    const totalWeight = Math.max(0, Number(nextGoldWeightMg ?? 0) + Number(nextBenefitWeightMg ?? 0));
    const deductWeight = Math.min(legacyShopWeightMg, totalWeight);
    if (deductWeight > 0 && settlementMode === RedemptionMode.GOLD_HANDOVER) {
      const fromBenefit = Math.min(deductWeight, nextBenefitWeightMg ?? 0);
      const fromPrincipal = deductWeight - fromBenefit;
      nextBenefitWeightMg = Math.max(0, (nextBenefitWeightMg ?? 0) - fromBenefit);
      nextGoldWeightMg = Math.max(0, (nextGoldWeightMg ?? 0) - fromPrincipal);
      extraLines.push({
        key: "ECOMMERCE_SCHEME_SPEND",
        label: completedCount === 1 ? "Online shop purchase" : `Online shop purchases (${completedCount})`,
        amount: moneyField(0),
        sign: "-",
        weight: { weightMg: deductWeight, weightDisplay: `${(deductWeight / 1000).toFixed(3)} g` },
        note: "Net gold weight after returns, applied when the order was delivered or picked up.",
      });
    } else if (legacyShopPaise > 0 && nextSettlementPaise > 0) {
      const deduction = Math.min(legacyShopPaise, nextSettlementPaise);
      extraLines.push({
        key: "ECOMMERCE_SCHEME_SPEND",
        label: "Online shop purchases",
        amount: moneyField(deduction),
        sign: "-",
      });
      nextSettlementPaise -= deduction;
    }
  }

  if (nextSettlementPaise <= 0 && (usedPaise > 0 || ledgerOnline.amountPaise > 0) && scheme.valueBasis === ValueBasis.CASH) {
    blockers.push({
      code: "SCHEME_SETTLED_VIA_ONLINE_SHOP",
      message: "This scheme value was used for online shop checkout. No separate cash payout remains.",
    });
  }

  const pendingPaise = Math.max(heldPaise, pending.reduce((sum, row) => sum + Number(row.appliedPaise ?? 0), 0));
  if (
    (heldPaise > 0 || pending.length)
    && pendingPaise > 0
    && scheme.valueBasis === ValueBasis.CASH
    && settlementMode !== RedemptionMode.PURCHASE_ADJUSTMENT
  ) {
    blockers.push({
      code: "ECOMMERCE_SCHEME_HOLD_ACTIVE",
      message: heldPaise > 0
        ? `${moneyRef(heldPaise).amountDisplay} is reserved for shop orders in progress. Wait for delivery or cancellation before requesting cash payout.`
        : `A shop checkout is reserving ${moneyRef(pendingPaise).amountDisplay}. Wait for it to complete or expire before requesting cash payout.`,
    });
  }

  if (heldWeightMg > 0 && settlementMode === RedemptionMode.GOLD_HANDOVER) {
    notes.push(
      `${(heldWeightMg / 1000).toFixed(3)} g is reserved for shop fulfilment — not deducted from this handover quote yet.`,
    );
  }

  if (!extraLines.length && !notes.length && !blockers.length) return null;

  return {
    extraLines,
    notes,
    blockers,
    settlementPaise: nextSettlementPaise,
    goldWeightMg: nextGoldWeightMg,
    benefitWeightMg: nextBenefitWeightMg,
    ecommerceScheme: {
      completedOrderCount: completedCount,
      failedAttemptCount: failed.length,
      pendingAttemptCount: pending.length,
      completedSpendPaise: usedPaise > 0 ? usedPaise : undefined,
      completedSpendWeightMg: usedWeightMg > 0 ? usedWeightMg : undefined,
      heldSpendPaise: heldPaise > 0 ? heldPaise : undefined,
      heldSpendWeightMg: heldWeightMg > 0 ? heldWeightMg : undefined,
      notes,
    },
  };
}