import test from "node:test";
import assert from "node:assert/strict";
import {
  CashSettlementBasis,
  PaidAmountBenefitTreatment,
  RedemptionMode,
} from "../src/constants/enums.js";
import {
  isLegacyPaidAmountExcludeBenefitMisreported,
  resolveCalculatedBenefitPaise,
  resolveIncludedBenefitPaise,
} from "../src/lib/redemption-benefit-accounting.js";

test("legacy PAID_AMOUNT EXCLUDE misreported row resolves zero paid benefit", () => {
  const row = {
    mode: RedemptionMode.CASH,
    benefitPaise: 50_000,
    modeDetails: {
      settlementSnapshot: {
        mode: RedemptionMode.CASH,
        cashSettlementBasis: CashSettlementBasis.PAID_AMOUNT,
        paidAmountBenefitTreatment: PaidAmountBenefitTreatment.EXCLUDE,
      },
    },
  };
  assert.equal(isLegacyPaidAmountExcludeBenefitMisreported(row), true);
  assert.equal(resolveIncludedBenefitPaise(row), 0);
  assert.equal(resolveCalculatedBenefitPaise(row), 50_000);
});

test("new split-field EXCLUDE row is not legacy misreported", () => {
  const row = {
    mode: RedemptionMode.CASH,
    benefitPaise: 0,
    calculatedBenefitPaise: 50_000,
    includedBenefitPaise: 0,
    modeDetails: {
      settlementSnapshot: {
        cashSettlementBasis: CashSettlementBasis.PAID_AMOUNT,
        paidAmountBenefitTreatment: PaidAmountBenefitTreatment.EXCLUDE,
      },
    },
  };
  assert.equal(isLegacyPaidAmountExcludeBenefitMisreported(row), false);
  assert.equal(resolveIncludedBenefitPaise(row), 0);
});

test("legacy GOLD_VALUE row with benefitPaise only keeps paid benefit", () => {
  const row = {
    mode: RedemptionMode.CASH,
    benefitPaise: 40_000,
    modeDetails: {
      settlementSnapshot: {
        cashSettlementBasis: CashSettlementBasis.GOLD_VALUE,
      },
    },
  };
  assert.equal(isLegacyPaidAmountExcludeBenefitMisreported(row), false);
  assert.equal(resolveIncludedBenefitPaise(row), 40_000);
});
