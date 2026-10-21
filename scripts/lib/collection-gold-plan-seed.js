import { PaymentPattern, SchemePlanStatus } from "../../src/constants/enums.js";

export const COLLECTION_GOLD_RULES = {
  rateSource: "TENANT_DAILY_RATE",
  weightRoundingMode: "HALF_UP",
  weightPrecisionMg: 1,
  blockPaymentIfRateNotSet: true,
};

export const COLLECTION_PLAN_AVAILABILITY = {
  allBranches: true,
  branchIds: [],
  visibleInCustomerApp: true,
  customerSelfEnrolAllowed: true,
};

const COLLECTION_FREQUENCY_TERMS =
  "At enrolment the customer chooses Daily, Weekly, or Monthly collection. " +
  "Record the choice on the customer profile. The target collection amount is chosen at enrolment " +
  "(within plan limits). Daily/weekly collections are recorded as partial payments toward the monthly cycle.";

export function buildCollectionGoldPlan({ code, name, displayName, lockInMonths, bonusPercent }) {
  return {
    name,
    code,
    displayName,
    description: `${displayName}: ${lockInMonths}-month gold collection with ${bonusPercent}% total maturity bonus on accumulated gold.`,
    valueBasis: "GOLD_WEIGHT",
    paymentPattern: PaymentPattern.FIXED,
    durationMonths: lockInMonths,
    installmentCount: lockInMonths,
    amountRules: {
      amountMode: "CUSTOMER_CHOSEN",
      minInstallmentPaise: 5_000,
      maxInstallmentPaise: 10_000_000,
      multipleOfPaise: 100,
    },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      graceDays: 5,
      firstInstallmentModeDefault: "START_NEXT_CYCLE",
      firstInstallmentModeEditable: true,
    },
    paymentRules: {
      partialPaymentAllowed: true,
      advancePaymentAllowed: true,
      maxAdvanceInstallments: 2,
      minPaymentPaise: 100,
      maxPaymentPerTransactionPaise: 10_000_000,
    },
    goldRules: COLLECTION_GOLD_RULES,
    benefit: {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "PERCENT_OF_PAID",
      bonusValue: bonusPercent,
      displayLabel: `${bonusPercent}% additional gold at maturity (total benefit, not monthly)`,
      eligibility: {
        requireAllInstallmentsPaid: true,
        maxAllowedDefaults: 0,
        minMonthsCompleted: lockInMonths,
      },
    },
    redemptionRules: {
      prematureClosureAllowed: true,
      lockInMonths,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 100, benefitTreatment: "FORFEIT" },
      allowedModes: ["GOLD_HANDOVER", "PURCHASE_ADJUSTMENT"],
      redeemAtAnyBranch: true,
    },
    availability: COLLECTION_PLAN_AVAILABILITY,
    termsText: [
      `1. Lock-in: ${lockInMonths} months. Maturity bonus: ${bonusPercent}% of total gold purchased through collections, credited once when lock-in completes.`,
      "2. The bonus is a total maturity benefit — not applied as a monthly percentage.",
      `3. ${COLLECTION_FREQUENCY_TERMS}`,
      "4. Each successful collection creates a dated ledger entry and updates accumulated gold weight.",
      "5. Bonus eligibility requires completing the lock-in period and plan payment rules.",
    ].join("\n"),
    status: SchemePlanStatus.ACTIVE,
  };
}

/** Swarna / Akshaya / Tritiya — shared product definition for demo tenants. */
export const STANDARD_COLLECTION_PLAN_DEFS = [
  { code: "SWARNA", name: "Swarna Collection", displayName: "Swarna", lockInMonths: 3, bonusPercent: 3 },
  { code: "AKSHAYA", name: "Akshaya Collection", displayName: "Akshaya", lockInMonths: 6, bonusPercent: 7 },
  { code: "TRITIYA", name: "Tritiya Collection", displayName: "Tritiya", lockInMonths: 12, bonusPercent: 15 },
];
