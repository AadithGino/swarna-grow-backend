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


// Aira uses real collection schedules and credits a percentage of net gold.
export function buildAiraCollectionPlan(definition) {
  const legacy = buildCollectionGoldPlan(definition);
  const { lockInMonths, bonusPercent } = definition;
  return {
    ...legacy,
    collectionRules: {
      frequencies: ["DAILY", "WEEKLY", "MONTHLY"],
      amountBasis: "PER_COLLECTION",
      maturityRule: "FIRST_PAYMENT_ANNIVERSARY",
    },
    scheduleRules: { ...legacy.scheduleRules, firstInstallmentModeDefault: "COLLECT_NOW", firstInstallmentModeEditable: false },
    paymentRules: { ...legacy.paymentRules, partialPaymentAllowed: false },
    benefit: {
      type: "MATURITY_GOLD_CREDIT",
      goldBonus: { bonusBasis: "NET_GOLD_WEIGHT", bonusPercent, requireAllCollections: true },
      displayLabel: `${bonusPercent}% additional gold at maturity`,
      eligibility: { requireAllInstallmentsPaid: true, maxAllowedDefaults: 0, minMonthsCompleted: 0 },
    },
    termsText: [
      "Choose Daily, Weekly or Monthly at enrolment. The chosen amount applies to each scheduled collection.",
      `The ${lockInMonths}-month lock-in starts on the first verified payment.`,
      `Complete all scheduled collections to receive ${bonusPercent}% of your net accumulated gold at maturity.`,
      "Early closure forfeits the bonus. Redemption is available through gold handover or purchase adjustment.",
    ].join("\n"),
  };
}

export function buildAiraUpfrontPlan({ maximumUpfrontPaise }) {
  const minimumUpfrontPaise = 10_000_000;
  return {
    name: "Aira Upfront Gold Lock-in",
    displayName: "Aira Upfront Gold Lock-in",
    code: "AIRAUPFRONT",
    description: "Pay once upfront. Gold is locked for 12 months and earns a 2% gold credit each month.",
    valueBasis: "GOLD_WEIGHT",
    paymentPattern: PaymentPattern.FIXED,
    durationMonths: 12,
    installmentCount: 1,
    oneTimeRules: {
      timing: "MONTHLY",
      basis: "PRINCIPAL_PERCENT",
      value: 2,
      amountPeriod: "PER_PERIOD",
    },
    amountRules: {
      amountMode: "CUSTOMER_CHOSEN",
      minInstallmentPaise: minimumUpfrontPaise,
      maxInstallmentPaise: maximumUpfrontPaise,
      multipleOfPaise: 100,
    },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      graceDays: 0,
      firstInstallmentModeDefault: "COLLECT_NOW",
      firstInstallmentModeEditable: false,
    },
    paymentRules: {
      partialPaymentAllowed: false,
      advancePaymentAllowed: false,
      maxAdvanceInstallments: 0,
      minPaymentPaise: minimumUpfrontPaise,
      maxPaymentPerTransactionPaise: maximumUpfrontPaise,
    },
    goldRules: COLLECTION_GOLD_RULES,
    redemptionRules: {
      prematureClosureAllowed: false,
      lockInMonths: 12,
      prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
      allowedModes: ["GOLD_HANDOVER", "PURCHASE_ADJUSTMENT"],
      redeemAtAnyBranch: true,
    },
    availability: COLLECTION_PLAN_AVAILABILITY,
    termsText: [
      "Make one upfront payment of at least ₹1,00,000. The lock-in starts on the verified payment date.",
      "For 12 months, each monthly credit is 2% of the principal gold weight, calculated without compounding.",
      "Principal and posted bonus gold become redeemable at maturity through gold handover or purchase adjustment.",
    ].join("\n"),
    status: SchemePlanStatus.ACTIVE,
  };
}
