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
import { isSystemPolicyClosureSettlement } from "./system-policy-closure.js";

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
    "principalWeightMg",
    "benefitPaise",
    "benefitWeightMg",
    "penaltyPaise",
    "penaltyWeightMg",
    "goldWeightMg",
    "weightMg",
    "benefitRatePerGramPaise",
    "valuationRatePerGramPaise",
  ];
  for (const key of keys) {
    if (stored?.[key] == null && fresh?.[key] == null) continue;
    if (Number(stored?.[key] ?? 0) !== Number(fresh?.[key] ?? 0)) return true;
  }
  if (
    String(stored?.valuationRateEffectiveDate ?? "")
    !== String(fresh?.valuationRateEffectiveDate ?? "")
  ) {
    return true;
  }
  if (stored?.mode != null && fresh?.mode != null && stored.mode !== fresh.mode) {
    return true;
  }
  if (Boolean(stored?.systemPolicyClosure) !== Boolean(fresh?.systemPolicyClosure)) {
    return true;
  }
  if (
    String(stored?.closureReason ?? "")
    !== String(fresh?.closureReason ?? "")
  ) {
    return true;
  }
  return false;
}

export function sanitizeSettlementClassificationFromRequest(req) {
  if (req.body?.systemPolicyClosure !== undefined) delete req.body.systemPolicyClosure;
  if (req.query?.systemPolicyClosure !== undefined) delete req.query.systemPolicyClosure;
  if (req.body?.closureReason !== undefined) delete req.body.closureReason;
  if (req.query?.closureReason !== undefined) delete req.query.closureReason;
  const modeDetails = req.body?.modeDetails;
  if (modeDetails && typeof modeDetails === "object") {
    delete modeDetails.systemPolicyClosure;
    delete modeDetails.closureReason;
  }
}

export function settlementSnapshotClassificationInvalid(snapshot, scheme, freshPreview) {
  const liveSystemPolicy = isSystemPolicyClosureSettlement(scheme);
  const snapSystemPolicy = Boolean(snapshot?.systemPolicyClosure);
  const freshSystemPolicy = Boolean(freshPreview?.systemPolicyClosure);
  if (snapSystemPolicy !== freshSystemPolicy) return true;
  if (snapSystemPolicy !== liveSystemPolicy) return true;
  const snapReason = String(snapshot?.closureReason ?? "");
  const freshReason = String(freshPreview?.closureReason ?? "");
  const liveReason = liveSystemPolicy ? String(scheme.closureReason ?? "") : "";
  if (snapReason !== freshReason) return true;
  if (liveSystemPolicy && snapReason !== liveReason) return true;
  if (snapSystemPolicy && !scheme.settlementRequired) return true;
  if (liveSystemPolicy && scheme.settlementCompletedAt) {
    // completion preview should be ineligible; figures may still match snapshot
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
  let handoverValuePaise = 0;
  let roundingDeltaPaise = 0;

  const needsExactRate =
    mode === RedemptionMode.GOLD_HANDOVER
    || (
      scheme.valueBasis === ValueBasis.GOLD_WEIGHT
      && (
        benefitPaise > 0
        || mode === RedemptionMode.CASH
        || mode === RedemptionMode.PURCHASE_ADJUSTMENT
        || penaltyPaise > 0
      )
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
    // Cash and purchase value principal + benefit. Handover uses that weight after penalty.
    weightMg = modeSettlement.finalHandoverWeightMg;
    if (mode === RedemptionMode.GOLD_HANDOVER) {
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
    if (
      mode === RedemptionMode.GOLD_HANDOVER
      && exactRate
      && blockers.length === 0
    ) {
      const { rounding, precisionMg } = resolvePlanGoldRounding(scheme, tenantOps);
      let handoverWeightMg = moneyToWeightMg(
        settlementPaise,
        exactRate.ratePerGramPaise,
        rounding,
      );
      handoverWeightMg = applyWeightPrecisionMg(
        handoverWeightMg,
        precisionMg,
        rounding,
      );
      weightMg = handoverWeightMg;
      if (!(handoverWeightMg > 0)) {
        blockers.push({
          code: "GOLD_WEIGHT_ROUNDS_TO_ZERO",
          message: "Settlement rounds to zero gold weight at the applicable rate.",
        });
      } else {
        handoverValuePaise = moneyPaiseFromWeightMg(
          handoverWeightMg,
          exactRate.ratePerGramPaise,
        );
        roundingDeltaPaise = settlementPaise - handoverValuePaise;
      }
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

  if (
    systemPolicyClosure
    && settlementPaise <= 0
    && blockers.length === 0
  ) {
    blockers.push({
      code: "SETTLEMENT_PRINCIPAL_ZERO",
      message: "No refundable principal remains for settlement.",
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
    handoverValuePaise,
    roundingDeltaPaise,
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

export const SETTLEMENT_SNAPSHOT_NUMERIC_KEYS = Object.freeze([
  "schemeVersion",
  "principalPaise",
  "principalWeightMg",
  "benefitPaise",
  "benefitWeightMg",
  "benefitRatePerGramPaise",
  "penaltyPaise",
  "penaltyWeightMg",
  "settlementPaise",
  "goldWeightMg",
  "weightMg",
  "valuationRatePerGramPaise",
]);

export const SETTLEMENT_SNAPSHOT_STRING_KEYS = Object.freeze([
  "computedAt",
  "valuationRateEffectiveDate",
  "mode",
  "closureReason",
]);

export const SETTLEMENT_SNAPSHOT_BOOLEAN_KEYS = Object.freeze([
  "systemPolicyClosure",
]);

export const SETTLEMENT_SNAPSHOT_FIELD_KEYS = Object.freeze([
  ...SETTLEMENT_SNAPSHOT_NUMERIC_KEYS,
  ...SETTLEMENT_SNAPSHOT_STRING_KEYS,
  ...SETTLEMENT_SNAPSHOT_BOOLEAN_KEYS,
]);

export function buildSettlementSnapshotFromPreview(preview, schemeVersion, mode) {
  return {
    schemeVersion,
    mode,
    systemPolicyClosure: Boolean(preview.systemPolicyClosure),
    closureReason: preview.closureReason ?? "",
    principalPaise: preview.principalPaise,
    principalWeightMg: preview.goldWeightMg ?? preview.principalWeightMg ?? 0,
    benefitPaise: preview.benefitPaise,
    benefitWeightMg: preview.benefitWeightMg,
    benefitRatePerGramPaise: preview.benefitRatePerGramPaise,
    penaltyPaise: preview.penaltyPaise,
    penaltyWeightMg: preview.penaltyWeightMg,
    settlementPaise: preview.settlementPaise,
    goldWeightMg: preview.goldWeightMg,
    weightMg: preview.weightMg,
    valuationRatePerGramPaise: preview.valuationRatePerGramPaise ?? 0,
    valuationRateEffectiveDate: preview.valuationRateEffectiveDate ?? "",
    computedAt: new Date().toISOString(),
  };
}

export function assertSettlementSnapshotComplete(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return { ok: false, code: "SETTLEMENT_SNAPSHOT_REQUIRED" };
  }
  for (const key of SETTLEMENT_SNAPSHOT_NUMERIC_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
      return { ok: false, code: "SETTLEMENT_SNAPSHOT_REQUIRED" };
    }
    const value = snapshot[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, code: "SETTLEMENT_SNAPSHOT_REQUIRED" };
    }
  }
  for (const key of SETTLEMENT_SNAPSHOT_STRING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
      return { ok: false, code: "SETTLEMENT_SNAPSHOT_REQUIRED" };
    }
    const value = snapshot[key];
    if (typeof value !== "string") {
      return { ok: false, code: "SETTLEMENT_SNAPSHOT_REQUIRED" };
    }
    if (key === "computedAt" && !value.trim()) {
      return { ok: false, code: "SETTLEMENT_SNAPSHOT_REQUIRED" };
    }
    if (key === "mode" && !value.trim()) {
      return { ok: false, code: "SETTLEMENT_SNAPSHOT_REQUIRED" };
    }
  }
  for (const key of SETTLEMENT_SNAPSHOT_BOOLEAN_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
      return { ok: false, code: "SETTLEMENT_SNAPSHOT_REQUIRED" };
    }
    if (typeof snapshot[key] !== "boolean") {
      return { ok: false, code: "SETTLEMENT_SNAPSHOT_REQUIRED" };
    }
  }
  return { ok: true };
}

export { ClosureType };
