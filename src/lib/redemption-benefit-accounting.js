import {
  CashSettlementBasis,
  PaidAmountBenefitTreatment,
  RedemptionMode,
} from "../constants/enums.js";

export function settlementSnapshotFromRedemption(redemption) {
  return redemption?.modeDetails?.settlementSnapshot ?? null;
}

export function isPaidAmountExcludeCashSettlement({ mode, snapshot }) {
  if (mode !== RedemptionMode.CASH || !snapshot) return false;
  return (
    snapshot.cashSettlementBasis === CashSettlementBasis.PAID_AMOUNT
    && snapshot.paidAmountBenefitTreatment === PaidAmountBenefitTreatment.EXCLUDE
  );
}

/** Rows completed before split benefit fields; benefitPaise stored calculated bonus only. */
export function isLegacyPaidAmountExcludeBenefitMisreported(redemption) {
  const snapshot = settlementSnapshotFromRedemption(redemption);
  if (!isPaidAmountExcludeCashSettlement({ mode: redemption?.mode, snapshot })) {
    return false;
  }
  if (hasPersistedBenefitSplitFields(redemption)) return false;
  return Math.max(0, Number(redemption?.benefitPaise ?? 0)) > 0;
}

export function hasPersistedBenefitSplitFields(redemption) {
  if (redemption?.includedBenefitPaise != null) return true;
  const calculated = redemption?.calculatedBenefitPaise;
  return calculated != null && calculated > 0;
}

function legacyMisreportedBenefitAggregationCase() {
  const snap = "$modeDetails.settlementSnapshot";
  return {
    $and: [
      { $eq: ["$mode", RedemptionMode.CASH] },
      {
        $eq: [
          { $ifNull: [`${snap}.cashSettlementBasis`, ""] },
          CashSettlementBasis.PAID_AMOUNT,
        ],
      },
      {
        $eq: [
          { $ifNull: [`${snap}.paidAmountBenefitTreatment`, ""] },
          PaidAmountBenefitTreatment.EXCLUDE,
        ],
      },
      { $lte: [{ $ifNull: ["$calculatedBenefitPaise", 0] }, 0] },
      { $eq: [{ $ifNull: ["$includedBenefitPaise", null] }, null] },
      { $gt: [{ $ifNull: ["$benefitPaise", 0] }, 0] },
    ],
  };
}

/** Mongo aggregation: benefit actually paid/credited in paise (legacy-safe). */
export function includedBenefitPaiseAggregationExpr() {
  const modernIncluded = {
    $switch: {
      branches: [
        {
          case: { $gt: [{ $ifNull: ["$calculatedBenefitPaise", 0] }, 0] },
          then: { $ifNull: ["$includedBenefitPaise", 0] },
        },
      ],
      default: { $ifNull: ["$benefitPaise", 0] },
    },
  };
  return {
    $cond: [legacyMisreportedBenefitAggregationCase(), 0, modernIncluded],
  };
}

export function resolveCalculatedBenefitPaise(redemption) {
  if (isLegacyPaidAmountExcludeBenefitMisreported(redemption)) {
    return Math.max(0, Number(redemption?.benefitPaise ?? 0));
  }
  const calculated = redemption?.calculatedBenefitPaise;
  if (calculated != null && calculated > 0) {
    return Math.max(0, Number(calculated));
  }
  return Math.max(0, Number(redemption?.benefitPaise ?? 0));
}

export function resolveIncludedBenefitPaise(redemption) {
  if (isLegacyPaidAmountExcludeBenefitMisreported(redemption)) {
    return 0;
  }
  const calculated = redemption?.calculatedBenefitPaise;
  if (calculated != null && calculated > 0) {
    return Math.max(0, Number(redemption?.includedBenefitPaise ?? 0));
  }
  const legacyBenefit = Math.max(0, Number(redemption?.benefitPaise ?? 0));
  if (legacyBenefit > 0) return legacyBenefit;
  return Math.max(0, Number(redemption?.includedBenefitPaise ?? 0));
}

export function computeIncludedBenefitPaiseFromClosure({
  benefitPaise,
  paidAmountCashSettlement,
  mode,
  includedMonetaryBenefitPaise,
}) {
  const calculated = Math.max(0, Number(benefitPaise ?? 0));
  if (calculated <= 0) return 0;
  if (paidAmountCashSettlement && mode === RedemptionMode.CASH) {
    return Math.max(0, Number(includedMonetaryBenefitPaise ?? 0));
  }
  return calculated;
}

export function benefitFieldsFromSettlementPreview(preview) {
  const calculatedBenefitPaise = Math.max(
    0,
    Number(preview.calculatedBenefitPaise ?? preview.benefitPaise ?? 0),
  );
  const includedBenefitPaise =
    preview.includedBenefitPaise != null
      ? Math.max(0, Number(preview.includedBenefitPaise))
      : preview.includedMonetaryBenefitPaise != null
        ? Math.max(0, Number(preview.includedMonetaryBenefitPaise))
        : calculatedBenefitPaise;
  return {
    calculatedBenefitPaise,
    includedBenefitPaise,
    /** Persisted benefitPaise = amount actually paid/credited (reporting). */
    benefitPaise: includedBenefitPaise,
  };
}

export function enrichRedemptionBenefitForRead(redemption) {
  const calculatedBenefitPaise = resolveCalculatedBenefitPaise(redemption);
  const includedBenefitPaise = resolveIncludedBenefitPaise(redemption);
  const benefitExcludedFromPayout =
    calculatedBenefitPaise > 0 && includedBenefitPaise === 0;
  return {
    calculatedBenefitPaise,
    includedBenefitPaise,
    benefitExcludedFromPayout,
  };
}

/**
 * Fill legacy snapshot fields so in-flight redemptions can complete after schema additions.
 * Does not rewrite stored history for completed rows.
 */
export function normalizeSettlementSnapshotForValidation(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const normalized = { ...snapshot };
  if (normalized.cashSettlementBasis == null) {
    normalized.cashSettlementBasis = "GOLD_VALUE";
  }
  if (normalized.paidAmountBenefitTreatment == null) {
    normalized.paidAmountBenefitTreatment = PaidAmountBenefitTreatment.EXCLUDE;
  }
  const legacyBenefit = Number(normalized.benefitPaise ?? 0);
  if (normalized.calculatedBenefitPaise == null) {
    normalized.calculatedBenefitPaise = legacyBenefit;
  }
  if (normalized.includedBenefitPaise == null) {
    const paidAmount =
      normalized.cashSettlementBasis === "PAID_AMOUNT"
      && normalized.mode === RedemptionMode.CASH;
    if (
      paidAmount
      && normalized.paidAmountBenefitTreatment
        === PaidAmountBenefitTreatment.EXCLUDE
    ) {
      normalized.includedBenefitPaise = 0;
    } else {
      normalized.includedBenefitPaise = legacyBenefit;
    }
  }
  return normalized;
}
