import test from "node:test";
import assert from "node:assert/strict";
import { planBody } from "../src/validators/common.validators.js";
import { RedemptionMode } from "../src/constants/enums.js";

const planBase = {
  name: "Txncap plan",
  code: "TXNCAP01",
  valueBasis: "CASH",
  paymentPattern: "FIXED",
  durationMonths: 12,
  installmentCount: 12,
  amountRules: { amountMode: "JEWELLER_FIXED", fixedAmountPaise: 100_000 },
  scheduleRules: {
    dueDateRule: "FIXED_DAY_OF_MONTH",
    dueDayOfMonth: 5,
    firstInstallmentModeDefault: "START_NEXT_CYCLE",
  },
  paymentRules: { partialPaymentAllowed: false, minPaymentPaise: 100_000 },
  redemptionRules: {
    prematureClosureAllowed: false,
    lockInMonths: 0,
    prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
    allowedModes: [RedemptionMode.CASH],
    redeemAtAnyBranch: false,
  },
  availability: {
    allBranches: true,
    branchIds: [],
    visibleInCustomerApp: true,
    customerSelfEnrolAllowed: true,
  },
  benefit: {
    type: "TEXT_ONLY",
    displayLabel: "Gift voucher",
    eligibility: {
      requireAllInstallmentsPaid: true,
      maxAllowedDefaults: 0,
      minMonthsCompleted: 0,
    },
  },
};

test("customer-chosen max>cap partial OFF is rejected", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "TXNCC1",
    amountRules: {
      amountMode: "CUSTOMER_CHOSEN",
      minInstallmentPaise: 10_000,
      maxInstallmentPaise: 200_000,
      multipleOfPaise: 1_000,
    },
    paymentRules: {
      partialPaymentAllowed: false,
      minPaymentPaise: 10_000,
      maxPaymentPerTransactionPaise: 100_000,
    },
  });
  assert.equal(parsed.success, false);
});

test("slab>cap partial ON is accepted", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "TXNSLB1",
    amountRules: {
      amountMode: "JEWELLER_SLABS",
      slabsPaise: [50_000, 150_000],
    },
    paymentRules: {
      partialPaymentAllowed: true,
      minPaymentPaise: 10_000,
      maxPaymentPerTransactionPaise: 100_000,
    },
  });
  assert.equal(parsed.success, true);
});

test("min payment>cap partial ON is rejected", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "TXNMIN1",
    amountRules: {
      amountMode: "CUSTOMER_CHOSEN",
      minInstallmentPaise: 10_000,
      maxInstallmentPaise: 80_000,
      multipleOfPaise: 1_000,
    },
    paymentRules: {
      partialPaymentAllowed: true,
      minPaymentPaise: 50_000,
      maxPaymentPerTransactionPaise: 40_000,
    },
  });
  assert.equal(parsed.success, false);
});

test("fixed>cap partial OFF is rejected", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "TXNFIX1",
    paymentRules: {
      partialPaymentAllowed: false,
      minPaymentPaise: 100_000,
      maxPaymentPerTransactionPaise: 50_000,
    },
  });
  assert.equal(parsed.success, false);
});

test("customer-chosen max<=cap partial OFF is accepted", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "TXNCC2",
    amountRules: {
      amountMode: "CUSTOMER_CHOSEN",
      minInstallmentPaise: 10_000,
      maxInstallmentPaise: 100_000,
      multipleOfPaise: 1_000,
    },
    paymentRules: {
      partialPaymentAllowed: false,
      minPaymentPaise: 10_000,
      maxPaymentPerTransactionPaise: 100_000,
    },
  });
  assert.equal(parsed.success, true);
});

test("slab>cap partial OFF is rejected", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "TXNSLB2",
    amountRules: {
      amountMode: "JEWELLER_SLABS",
      slabsPaise: [50_000, 150_000],
    },
    paymentRules: {
      partialPaymentAllowed: false,
      minPaymentPaise: 50_000,
      maxPaymentPerTransactionPaise: 100_000,
    },
  });
  assert.equal(parsed.success, false);
});

test("customer-chosen with no bounds is rejected", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "TXNCC3",
    amountRules: { amountMode: "CUSTOMER_CHOSEN" },
    paymentRules: { partialPaymentAllowed: true, minPaymentPaise: 10_000 },
  });
  assert.equal(parsed.success, false);
});

test("advance enabled with maxAdvanceInstallments 0 is rejected", () => {
  const parsed = planBody.safeParse({
    ...planBase,
    code: "TXNADV1",
    paymentRules: {
      partialPaymentAllowed: false,
      minPaymentPaise: 100_000,
      advancePaymentAllowed: true,
      maxAdvanceInstallments: 0,
    },
  });
  assert.equal(parsed.success, false);
});
