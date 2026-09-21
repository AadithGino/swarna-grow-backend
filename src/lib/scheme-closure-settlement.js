import { ClosureType, RedemptionMode, ValueBasis } from "../constants/enums.js";
import { goldRateForExactDate } from "./gold-rate-lookup.js";
import { computeClosureBenefitPaise } from "./scheme-benefit.js";
import { computeClosurePenaltyPaise } from "./scheme-closure-penalty.js";
import {
  applyWeightPrecisionMg,
  decimalRoundingMode,
  moneyPaiseFromWeightMg,
  moneyToWeightMg,
} from "./money.js";
import { computeNetAllocatedLedgerTotals } from "./flexible-lock-settlement.js";

export function resolvePlanGoldRounding(scheme, tenantOps) {
  const goldRules = scheme.planSnapshot?.goldRules ?? {};
  const rounding = decimalRoundingMode(
    goldRules.weightRoundingMode
      ?? tenantOps?.operations?.weightRoundingMode
      ?? "HALF_UP",
  );
  const precisionMg = goldRules.weightPrecisionMg ?? 1;
  return { goldRules, rounding, precisionMg };
}

export function convertMoneyToPlanWeightMg(
  amountPaise,
  ratePerGramPaise,
  rounding,
  precisionMg,
) {
  const paise = Math.max(0, Number(amountPaise ?? 0));
  if (!paise || !ratePerGramPaise) return 0;
  let mg = moneyToWeightMg(paise, ratePerGramPaise, rounding);
  mg = applyWeightPrecisionMg(mg, precisionMg, rounding);
  return mg;
}

export function convertBenefitPaiseToWeightMg(
  benefitPaise,
  ratePerGramPaise,
  rounding,
  precisionMg,
) {
  return convertMoneyToPlanWeightMg(
    benefitPaise,
    ratePerGramPaise,
    rounding,
    precisionMg,
  );
}

/**
 * Gold-weight plan settlement by redemption mode at a single exact-day 22K rate.
 * Penalty is applied once (paise for cash/purchase; weight for physical handover).
 */
export function computeGoldWeightModeSettlement({
  mode,
  principalWeightMg,
  benefitWeightMg,
  penaltyPaise,
  ratePerGramPaise,
  rounding,
  precisionMg,
}) {
  const principal = Math.max(0, Number(principalWeightMg ?? 0));
  const benefitW = Math.max(0, Number(benefitWeightMg ?? 0));
  const eligibleWeightMg = principal + benefitW;
  const penaltyWeightMg = convertMoneyToPlanWeightMg(
    penaltyPaise,
    ratePerGramPaise,
    rounding,
    precisionMg,
  );

  if (mode === RedemptionMode.GOLD_HANDOVER) {
    const finalHandoverWeightMg = applyWeightPrecisionMg(
      eligibleWeightMg - penaltyWeightMg,
      precisionMg,
      rounding,
    );
    const handoverValuePaise =
      finalHandoverWeightMg > 0
        ? moneyPaiseFromWeightMg(finalHandoverWeightMg, ratePerGramPaise)
        : 0;
    return {
      penaltyWeightMg,
      finalHandoverWeightMg,
      settlementPaise: handoverValuePaise,
      cashOutPaise: 0,
      handoverValuePaise,
      ledgerDebitWeightMg: finalHandoverWeightMg,
      ledgerDebitAmountPaise: handoverValuePaise,
    };
  }

  const eligibleValuePaise = moneyPaiseFromWeightMg(
    eligibleWeightMg,
    ratePerGramPaise,
  );
  const settlementPaise = Math.max(0, eligibleValuePaise - Math.max(0, penaltyPaise));
  const cashOutPaise =
    mode === RedemptionMode.CASH ? settlementPaise : 0;
  return {
    penaltyWeightMg,
    finalHandoverWeightMg: eligibleWeightMg,
    settlementPaise,
    cashOutPaise,
    handoverValuePaise: 0,
    ledgerDebitWeightMg: eligibleWeightMg,
    ledgerDebitAmountPaise: settlementPaise,
  };
}

export function closureSettlementFiguresDiffer(stored, fresh) {
  const keys = [
    "settlementPaise",
    "principalPaise",
    "benefitPaise",
    "benefitWeightMg",
    "penaltyPaise",
    "penaltyWeightMg",
    "goldWeightMg",
    "weightMg",
    "benefitRatePerGramPaise",
  ];
  for (const key of keys) {
    if (stored?.[key] == null && fresh?.[key] == null) continue;
    if (Number(stored?.[key] ?? 0) !== Number(fresh?.[key] ?? 0)) return true;
  }
  return false;
}

export async function computeClosureSettlementCore({
  scheme,
  ledgerEntries,
  excludedPaymentIds,
  closureType,
  valuationDateYmd,
  mode,
  tenantOps,
  systemPolicyClosure = false,
  benefitEligible,
  paidCount,
  monthsCompleted,
  lockInMet,
  requiredPaid,
  defaultCount,
  benefitDef,
  rules,
  isPremature,
}) {
  const blockers = [];
  const netTotals = computeNetAllocatedLedgerTotals(
    ledgerEntries,
    excludedPaymentIds,
  );
  const penaltyRule = isPremature && !systemPolicyClosure ? rules.prematurePenalty : null;
  const prematureBenefitTreatment = penaltyRule?.benefitTreatment ?? "FORFEIT";

  const benefitPaise = computeClosureBenefitPaise({
    scheme,
    totals: netTotals,
    benefitDef,
    benefitEligible,
    isPremature,
    prematureBenefitTreatment,
    systemPolicyClosure,
  });

  const penaltyPaise = computeClosurePenaltyPaise(penaltyRule, netTotals.amountPaidPaise, {
    isPremature,
    systemPolicyClosure,
  });

  let benefitWeightMg = 0;
  let benefitRatePerGramPaise = 0;
  let penaltyWeightMg = 0;
  let settlementPaise = 0;
  let weightMg = netTotals.goldWeightMg;
  let settlementRatePerGramPaise = 0;
  let settlementRateEffectiveDate = null;

  const needsExactRate =
    scheme.valueBasis === ValueBasis.GOLD_WEIGHT
    && (
      benefitPaise > 0
      || mode === RedemptionMode.CASH
      || mode === RedemptionMode.GOLD_HANDOVER
      || mode === RedemptionMode.PURCHASE_ADJUSTMENT
      || penaltyPaise > 0
    );

  let exactRate = null;
  if (needsExactRate) {
    exactRate = await goldRateForExactDate(
      { tenantId: scheme.tenantId, branchId: scheme.branchId },
      valuationDateYmd,
    );
    if (!exactRate || exactRate.effectiveDate !== valuationDateYmd) {
      blockers.push({
        code: "GOLD_RATE_NOT_SET",
        message: `Set the 22K gold rate for ${valuationDateYmd} before completing this settlement.`,
      });
    } else {
      settlementRatePerGramPaise = exactRate.ratePerGramPaise;
      settlementRateEffectiveDate = exactRate.effectiveDate;
      const { rounding, precisionMg } = resolvePlanGoldRounding(scheme, tenantOps);
      if (benefitPaise > 0) {
        benefitRatePerGramPaise = exactRate.ratePerGramPaise;
        benefitWeightMg = convertBenefitPaiseToWeightMg(
          benefitPaise,
          exactRate.ratePerGramPaise,
          rounding,
          precisionMg,
        );
        if (!(benefitWeightMg > 0)) {
          blockers.push({
            code: "GOLD_BENEFIT_ROUNDS_TO_ZERO",
            message:
              "The configured benefit rounds to zero gold weight at the applicable rate.",
          });
        }
      }
    }
  }

  if (scheme.valueBasis === ValueBasis.GOLD_WEIGHT && !mode) {
    blockers.push({
      code: "REDEMPTION_MODE_REQUIRED",
      message: "Redemption mode is required for gold-weight settlement.",
    });
  }

  if (scheme.valueBasis === ValueBasis.GOLD_WEIGHT && exactRate && blockers.length === 0 && mode) {
    const { rounding, precisionMg } = resolvePlanGoldRounding(scheme, tenantOps);
    const modeSettlement = computeGoldWeightModeSettlement({
      mode,
      principalWeightMg: netTotals.goldWeightMg,
      benefitWeightMg,
      penaltyPaise,
      ratePerGramPaise: exactRate.ratePerGramPaise,
      rounding,
      precisionMg,
    });
    penaltyWeightMg = modeSettlement.penaltyWeightMg;
    settlementPaise = modeSettlement.settlementPaise;
    if (mode === RedemptionMode.GOLD_HANDOVER) {
      weightMg = modeSettlement.finalHandoverWeightMg;
      if (!(weightMg > 0)) {
        blockers.push({
          code: "GOLD_WEIGHT_ROUNDS_TO_ZERO",
          message: "Handover weight is zero or negative after penalty.",
        });
      }
    } else if (!(settlementPaise > 0)) {
      blockers.push({
        code: "SETTLEMENT_NON_POSITIVE",
        message: "Settlement value is zero or negative after penalty.",
      });
    }
  } else if (scheme.valueBasis !== ValueBasis.GOLD_WEIGHT) {
    settlementPaise = Math.max(
      0,
      netTotals.amountPaidPaise + benefitPaise - penaltyPaise,
    );
    if (!(settlementPaise > 0) && blockers.length === 0) {
      blockers.push({
        code: "SETTLEMENT_NON_POSITIVE",
        message: "Settlement value is zero or negative after penalty.",
      });
    }
  } else if (scheme.valueBasis === ValueBasis.GOLD_WEIGHT && !needsExactRate) {
    settlementPaise = Math.max(
      0,
      netTotals.amountPaidPaise + benefitPaise - penaltyPaise,
    );
  }

  if (penaltyPaise > 0 && settlementPaise <= 0 && blockers.length === 0) {
    blockers.push({
      code: "SETTLEMENT_NON_POSITIVE",
      message: "Penalty exceeds the settlement value.",
    });
  }

  return {
    blockers,
    netTotals,
    benefitPaise,
    benefitWeightMg,
    benefitRatePerGramPaise,
    penaltyPaise,
    penaltyWeightMg,
    settlementPaise,
    principalPaise: netTotals.amountPaidPaise,
    goldWeightMg: netTotals.goldWeightMg,
    weightMg,
    prematureBenefitTreatment,
    penaltyRule,
    settlementRatePerGramPaise,
    settlementRateEffectiveDate,
    closureType,
    isPremature,
    paidCount,
    monthsCompleted,
    lockInMet,
    requiredPaid,
    defaultCount,
    benefitDef,
    rules,
    scheme,
  };
}

export function resolveSettlementModeFromReq(req) {
  return (
    req.query?.mode
    ?? req.body?.mode
    ?? req.body?.preferredMode
    ?? null
  );
}

export const SETTLEMENT_SNAPSHOT_FIELD_KEYS = Object.freeze([
  "schemeVersion",
  "principalPaise",
  "benefitPaise",
  "benefitWeightMg",
  "benefitRatePerGramPaise",
  "penaltyPaise",
  "penaltyWeightMg",
  "settlementPaise",
  "goldWeightMg",
  "weightMg",
  "computedAt",
]);

export function buildSettlementSnapshotFromPreview(preview, schemeVersion) {
  return {
    schemeVersion,
    principalPaise: preview.principalPaise,
    benefitPaise: preview.benefitPaise,
    benefitWeightMg: preview.benefitWeightMg,
    benefitRatePerGramPaise: preview.benefitRatePerGramPaise,
    penaltyPaise: preview.penaltyPaise,
    penaltyWeightMg: preview.penaltyWeightMg,
    settlementPaise: preview.settlementPaise,
    goldWeightMg: preview.goldWeightMg,
    weightMg: preview.weightMg,
    computedAt: new Date().toISOString(),
  };
}

export function assertSettlementSnapshotComplete(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return { ok: false, code: "SETTLEMENT_SNAPSHOT_REQUIRED" };
  }
  for (const key of SETTLEMENT_SNAPSHOT_FIELD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
      return { ok: false, code: "SETTLEMENT_SNAPSHOT_REQUIRED" };
    }
    const value = snapshot[key];
    if (key === "computedAt") {
      if (typeof value !== "string" || !value.trim()) return { ok: false, code: "SETTLEMENT_SNAPSHOT_REQUIRED" };
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, code: "SETTLEMENT_SNAPSHOT_REQUIRED" };
    }
  }
  return { ok: true };
}

export { ClosureType };
