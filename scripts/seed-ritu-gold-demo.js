/**
 * Ritu Gold and Diamonds — Palakkad client demo (admin + customer portal).
 *
 * Two 18-month gold-weight schemes:
 * 1) Fixed monthly instalment + 100% bonus gold (no MC on redemption — store policy in terms).
 * 2) Flexible savings for 18 cycles + 1 closure cycle; 5% bonus on maturity (gold weight).
 *
 * Usage: npm run seed:ritu-gold
 * Login: tenant RITUGOLD · mobile 9847654321 · password 2026
 */
import argon2 from "argon2";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  BillingCycle,
  CustomerStatus,
  PaymentPattern,
  PlanTier,
  SchemePlanStatus,
  TenantRole,
  TenantStatus,
  UserStatus,
  UserType,
} from "../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { createId } from "../src/lib/ids.js";
import { today } from "../src/lib/date.js";
import {
  Branch,
  Counter,
  Customer,
  GoldRate,
  SchemePlan,
  Tenant,
  User,
} from "../src/models/index.js";
import { nextSequence } from "../src/services/sequence.service.js";
import { seedRituDemoMatrix } from "./seed-ritu-gold-matrix.js";

const DEMO = {
  tenantCode: "RITUGOLD",
  tenantName: "Ritu Gold and Diamonds",
  displayName: "Ritu Gold & Diamonds",
  city: "Palakkad",
  ownerMobile: "9847654321",
  ownerPassword: "2026",
  goldRatePerGramPaise: 720_000, // ₹7,200/g 22K demo
};

const GOLD_RULES = {
  rateSource: "TENANT_DAILY_RATE",
  weightRoundingMode: "HALF_UP",
  weightPrecisionMg: 1,
  blockPaymentIfRateNotSet: true,
};

const CUSTOMER_APP_AVAILABILITY = {
  allBranches: true,
  branchIds: [],
  visibleInCustomerApp: true,
  customerSelfEnrolAllowed: true,
};

function fixed18GoldPlanBody() {
  return {
    name: "Ritu Fixed Gold 18",
    code: "RITU18FIX",
    displayName: "18-Month Fixed Gold Savings",
    description:
      "Fixed monthly payment for 18 months; jeweller credits the same value as bonus gold at maturity. No making charges on scheme redemption.",
    valueBasis: "GOLD_WEIGHT",
    paymentPattern: PaymentPattern.FIXED,
    durationMonths: 18,
    installmentCount: 18,
    amountRules: {
      amountMode: "JEWELLER_FIXED",
      fixedAmountPaise: 500_000,
      minInstallmentPaise: 500_000,
      maxInstallmentPaise: 500_000,
    },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      graceDays: 7,
      firstInstallmentModeDefault: "START_NEXT_CYCLE",
      firstInstallmentModeEditable: true,
    },
    paymentRules: {
      partialPaymentAllowed: false,
      advancePaymentAllowed: true,
      maxAdvanceInstallments: 2,
      minPaymentPaise: 500_000,
      maxPaymentPerTransactionPaise: 2_000_000,
    },
    goldRules: GOLD_RULES,
    benefit: {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "PERCENT_OF_PAID",
      bonusValue: 100,
      displayLabel: "100% bonus gold (same as total paid)",
      eligibility: {
        requireAllInstallmentsPaid: true,
        maxAllowedDefaults: 0,
        minMonthsCompleted: 18,
      },
    },
    redemptionRules: {
      prematureClosureAllowed: true,
      lockInMonths: 6,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 5, benefitTreatment: "FORFEIT" },
      allowedModes: ["GOLD_HANDOVER", "PURCHASE_ADJUSTMENT"],
      redeemAtAnyBranch: true,
    },
    availability: CUSTOMER_APP_AVAILABILITY,
    termsText:
      "1. Pay the fixed instalment each month for 18 months; each payment buys 22K gold at the day’s rate.\n2. On maturity, Ritu Gold and Diamonds credits bonus gold equal to 100% of your total contributions (same amount as bonus).\n3. Redemption is for gold jewellery/purchase adjustment with **no making charges (MC)** on scheme gold as per store policy.\n4. Missed instalments may affect benefit eligibility.",
    status: SchemePlanStatus.ACTIVE,
  };
}

function flexible18GoldPlanBody() {
  return {
    name: "Ritu Flexi Gold 18+1",
    code: "RITU18FLEX",
    displayName: "Flexible Gold Savings (18 months + closure)",
    description:
      "Save any amount during 18 flexible months; complete the closure cycle; 5% bonus gold at maturity. No MC on redemption.",
    valueBasis: "GOLD_WEIGHT",
    paymentPattern: PaymentPattern.FLEXIBLE,
    durationMonths: 19,
    installmentCount: 19,
    amountRules: {
      amountMode: "CUSTOMER_CHOSEN",
      minInstallmentPaise: 10_000,
      maxInstallmentPaise: 5_000_000,
      multipleOfPaise: 100,
    },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      graceDays: 7,
      firstInstallmentModeDefault: "START_NEXT_CYCLE",
      firstInstallmentModeEditable: true,
    },
    paymentRules: {
      partialPaymentAllowed: true,
      advancePaymentAllowed: false,
      maxAdvanceInstallments: 0,
      minPaymentPaise: 10_000,
    },
    flexibleRules: {
      phaseMode: "FLEXIBLE_THEN_CAPPED",
      capMode: "FLEXIBLE_PHASE_AVERAGE",
      carryForwardMode: "NONE",
      flexiblePhaseCycles: 18,
      cappedPhaseCycles: 1,
      averagingDivisor: 18,
      frequencyMode: "MULTIPLE",
      flexiblePhase: {
        minimumPaymentPaise: 10_000,
        maximumPaymentPaise: 5_000_000,
        paymentIncrementPaise: 100,
        paymentsRequiredPerCycle: 0,
      },
      capComputation: {
        formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
        roundingMode: "ROUND_UP",
        roundToNearestPaise: 100,
        minCycleCapPaise: 10_000,
        maxCycleCapPaise: 5_000_000,
        onZeroFlexiblePhaseTotal: "CLOSE_SCHEME",
        onBelowMinimumTotal: "USE_MINIMUM",
      },
      cappedPhase: {
        minimumPaymentPaise: 10_000,
        paymentIncrementPaise: 100,
        allowFinalRemainderBelowMinimum: true,
        allowFutureCyclePayment: false,
        maxAdvanceCycles: 0,
      },
    },
    goldRules: GOLD_RULES,
    benefit: {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "PERCENT_OF_PAID",
      bonusValue: 5,
      displayLabel: "5% bonus gold at maturity",
      eligibility: {
        requireAllInstallmentsPaid: true,
        maxAllowedDefaults: 0,
        minMonthsCompleted: 0,
      },
    },
    redemptionRules: {
      prematureClosureAllowed: true,
      lockInMonths: 6,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 5, benefitTreatment: "FORFEIT" },
      allowedModes: ["GOLD_HANDOVER", "PURCHASE_ADJUSTMENT"],
      redeemAtAnyBranch: true,
    },
    availability: CUSTOMER_APP_AVAILABILITY,
    termsText:
      "1. For 18 months you may contribute any amount within plan limits (multiple payments per month allowed).\n2. A final closure cycle follows; complete it to mature the scheme.\n3. At maturity (from the 19th month onward), Ritu Gold and Diamonds credits **5% bonus gold** on your total savings.\n4. Redemption is with **no making charges (MC)** on scheme gold as per store policy.",
    status: SchemePlanStatus.ACTIVE,
  };
}

async function wipeTenant(code) {
  const existing = await Tenant.findOne({ code }).lean();
  if (!existing) return;
  const tenantId = existing._id;
  const {
    LedgerEntry,
    Payment,
    PaymentIntent,
    PaymentLink,
    Scheme,
    Customer,
    SchemePlan,
    GoldRate,
    Redemption,
  } = await import("../src/models/index.js");
  await LedgerEntry.collection.deleteMany({ tenantId });
  for (const Model of [
    Payment,
    PaymentIntent,
    PaymentLink,
    Scheme,
    Redemption,
    Customer,
    SchemePlan,
    GoldRate,
  ]) {
    await Model.deleteMany({ tenantId });
  }
  await User.deleteMany({ tenantId, type: UserType.TENANT_USER });
  await Branch.deleteMany({ tenantId });
  await Counter.deleteMany({ _id: { $regex: `^${tenantId}:` } });
  await Tenant.deleteOne({ _id: tenantId });
}

function makeCtx(tenant, user) {
  return {
    auth: {
      id: user._id,
      tenantId: tenant._id,
      type: UserType.TENANT_USER,
      role: user.role,
    },
    scope: { tenantId: tenant._id },
    tenant,
    baseUrl: "/api/v1/admin",
    headers: { "user-agent": "seed-ritu-gold" },
    ip: "127.0.0.1",
    body: {},
    query: {},
  };
}

async function main() {
  await connectDatabase();
  await wipeTenant(DEMO.tenantCode);

  const tenantId = createId("tenant");
  const branchId = createId("branch");
  const ownerId = createId("user");
  const passwordHash = await argon2.hash(DEMO.ownerPassword, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  const tenant = await Tenant.create({
    _id: tenantId,
    code: DEMO.tenantCode,
    name: DEMO.tenantName,
    displayName: DEMO.displayName,
    mobile: "+919847654321",
    supportNumber: DEMO.ownerMobile,
    email: "demo@ritugold.in",
    status: TenantStatus.ACTIVE,
    address: {
      line1: "Sultanpet Road",
      city: "Palakkad",
      state: "Kerala",
      pincode: "678001",
    },
    branding: {
      primaryColor: "#6B1D1D",
      accentColor: "#C9A227",
      displayName: DEMO.displayName,
    },
    settings: {
      requireKycForEnrolment: false,
      oneActiveSchemePerCustomer: false,
      customerAppMaintenance: false,
    },
    operations: {
      multiSchemePerCustomer: true,
      receiptPrefix: "RG",
      customerSelfEnrolEnabled: true,
      customerSelfRegistrationEnabled: true,
      customerAppWriteEnabled: true,
      customerAppPaymentsEnabled: true,
      termsAndConditions: DEMO.tenantName + " — scheme terms as per enrolled plan.",
    },
    featureFlags: {
      customerAppEnabled: true,
      customerSelfEnrol: true,
      staffAppEnabled: false,
      onlinePayments: true,
      flexibleScheme: true,
      passbookImageOnPayment: false,
    },
    subscription: {
      tier: PlanTier.GROWTH,
      status: "ACTIVE",
      billingCycle: BillingCycle.MONTHLY,
      startsAt: new Date(),
      renewsAt: new Date(Date.now() + 365 * 86_400_000),
      limits: {
        activeCustomers: 2000,
        branches: 3,
        staff: 8,
        schemePlans: 10,
        whatsappMessages: 3000,
      },
    },
  });

  const branch = await Branch.create({
    _id: branchId,
    tenantId,
    code: "PLKD",
    name: "Palakkad Showroom",
    address: { line1: "Sultanpet Road", city: "Palakkad", pincode: "678001" },
    isHeadOffice: true,
    active: true,
  });

  const owner = await User.create({
    _id: ownerId,
    type: UserType.TENANT_USER,
    tenantId,
    branchId: null,
    role: TenantRole.TENANT_OWNER,
    name: "Ritu Gold Admin",
    mobile: DEMO.ownerMobile,
    passwordHash,
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.TENANT_OWNER],
  });

  await GoldRate.create({
    _id: createId("goldRate"),
    tenantId,
    branchId: null,
    ratePerGramPaise: DEMO.goldRatePerGramPaise,
    effectiveDate: today(),
    purity: "22K",
    source: "MANUAL",
    enteredBy: owner._id,
  });

  const fixedPlan = await SchemePlan.create({
    _id: createId("plan"),
    tenantId,
    ...fixed18GoldPlanBody(),
    createdBy: owner._id,
    version: 1,
  });
  const flexPlan = await SchemePlan.create({
    _id: createId("plan"),
    tenantId,
    ...flexible18GoldPlanBody(),
    createdBy: owner._id,
    version: 1,
  });

  const ctx = makeCtx(tenant, owner);

  const CUSTOMER_ROWS = [
    { name: "Anjali Menon", mobile: "9847654401" },
    { name: "Suresh Nair", mobile: "9847654402" },
    { name: "Priya Krishnan", mobile: "9847654403" },
    { name: "Ramesh Iyer", mobile: "9847654404" },
    { name: "Lakshmi Devi", mobile: "9847654405" },
    { name: "Vijay Kumar", mobile: "9847654406" },
    { name: "Meera Unni", mobile: "9847654407" },
    { name: "Gopal Menon", mobile: "9847654408" },
    { name: "Deepa Nambiar", mobile: "9847654409" },
    { name: "Arun Pillai", mobile: "9847654410" },
    { name: "Sneha Raj", mobile: "9847654411" },
    { name: "Kiran Das", mobile: "9847654412" },
    { name: "Nisha Varma", mobile: "9847654413" },
    { name: "Manoj Thomas", mobile: "9847654414" },
    { name: "Reena Joseph", mobile: "9847654415" },
    { name: "Biju Kurup", mobile: "9847654416" },
    { name: "Shalini Mohan", mobile: "9847654417" },
    { name: "Harish Nair", mobile: "9847654418" },
    { name: "Divya Sreekumar", mobile: "9847654419" },
    { name: "Sajan Mathew", mobile: "9847654420" },
    { name: "Asha Prasad", mobile: "9847654421" },
    { name: "Rohit Balakrishnan", mobile: "9847654422" },
  ];

  const customers = [];
  for (const row of CUSTOMER_ROWS) {
    const n = await nextSequence(tenantId, "customer");
    customers.push(
      await Customer.create({
        _id: createId("customer"),
        tenantId,
        branchId: branch._id,
        customerNumber: `CUS-${String(n).padStart(6, "0")}`,
        passbookNumber: `PB-${String(n).padStart(6, "0")}`,
        name: row.name,
        mobile: row.mobile,
        status: CustomerStatus.ACTIVE,
        kyc: { status: "VERIFIED", verifiedAt: new Date() },
      }),
    );
  }

  console.log("\nSeeding enrollments (~2–4 min; progress lines print as it runs)…\n");
  const matrixSummary = await seedRituDemoMatrix(ctx, {
    fixedPlan,
    flexPlan,
    branchId: branch._id,
    customers,
  });

  console.log("\n=== Ritu Gold and Diamonds demo ready ===\n");
  console.log(`Tenant code:  ${DEMO.tenantCode}`);
  console.log(`Portal login: ${DEMO.ownerMobile} / ${DEMO.ownerPassword}`);
  console.log(`Branch:       ${branch.name}, ${DEMO.city}`);
  console.log(`Plans:        ${fixedPlan.code} (fixed 18m + 100% bonus), ${flexPlan.code} (flex 18+1 + 5% bonus)`);
  console.log(`Customers:    ${customers.length} with ${matrixSummary.length} scenario enrollments\n`);
  console.log("Scenario map (search by customer name in portal):\n");
  for (const row of matrixSummary) {
    const enr = row.enrollment ? ` ${row.enrollment}` : "";
    console.log(`  · ${row.customer}${enr} — ${row.story}`);
  }
  console.log("\nCustomer app: enabled (OTP login with demo customer mobiles 9847654401–4422).\n");
  console.log("Customer URL: /customer/ritugold\n");

  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase();
  process.exit(1);
});
