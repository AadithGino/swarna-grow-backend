/**
 * Ekta — single jeweller with Gold Chitti (12-month, 11+1) only.
 *
 * Usage: node --env-file=.env scripts/seed-ekta-gold-chitti.js
 * Re-run: replaces tenant EKTA if it already exists.
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
import { DEFAULT_PLAN_FEATURES } from "../src/constants/plan-features.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { createId } from "../src/lib/ids.js";
import { today } from "../src/lib/date.js";
import { Branch, Customer, GoldRate, SchemePlan, SubscriptionPlan, Tenant, User } from "../src/models/index.js";
import { nextSequence } from "../src/services/sequence.service.js";
import { seedEktaGoldChittiDemoMatrix } from "./seed-ekta-gold-chitti-matrix.js";

const DEMO = {
  tenantCode: "EKTA",
  tenantName: "Ekta",
  displayName: "Ekta",
  city: "K.R. Nagar",
  state: "Karnataka",
  showroomLine: "Ekta Jewellers, K.R. Nagar",
  supportPhones: ["9591691619", "9108265311"],
  ownerName: "Ekta Admin",
  ownerMobile: process.env.EKTA_OWNER_MOBILE?.trim() || "9591691619",
  ownerPassword: process.env.EKTA_OWNER_PASSWORD?.trim() || "4321",
  goldRatePerGramPaise: 720_000,
};

function goldChittiPlanBody() {
  return {
    name: "Gold Chitti",
    code: "GOLDCHITTI",
    displayName: "Gold Chitti",
    description:
      "12-month chitti: fixed monthly instalments for 11 months; the jeweller credits the 12th month for you at maturity.",
    valueBasis: "CASH",
    paymentPattern: PaymentPattern.FIXED,
    durationMonths: 12,
    installmentCount: 12,
    amountRules: {
      amountMode: "CUSTOMER_CHOSEN",
      minInstallmentPaise: 500_00,
      maxInstallmentPaise: 1_000_000_00,
      multipleOfPaise: 100,
    },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      graceDays: 5,
      firstInstallmentModeDefault: "START_NEXT_CYCLE",
      firstInstallmentModeEditable: true,
    },
    paymentRules: {
      partialPaymentAllowed: false,
      advancePaymentAllowed: true,
      maxAdvanceInstallments: 2,
      minPaymentPaise: 500_00,
      maxPaymentPerTransactionPaise: 1_000_000_00,
    },
    benefit: {
      type: "ONE_FREE_INSTALLMENT",
      displayLabel: "Jeweller pays your 12th (final) monthly instalment",
      eligibility: {
        requireAllInstallmentsPaid: true,
        maxAllowedDefaults: 0,
        minMonthsCompleted: 12,
      },
    },
    redemptionRules: {
      prematureClosureAllowed: true,
      lockInMonths: 12,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 2, benefitTreatment: "FORFEIT" },
      allowedModes: ["PURCHASE_ADJUSTMENT", "GOLD_HANDOVER"],
      redeemAtAnyBranch: true,
    },
    availability: {
      allBranches: true,
      branchIds: [],
      visibleInCustomerApp: true,
      customerSelfEnrolAllowed: true,
    },
    termsText: [
      "1. Duration: A 12-month instalment plan.",
      "2. Payment structure: Pay a fixed monthly amount you choose at enrolment for the first 11 months.",
      "3. Special benefit: Ekta pays the fixed instalment amount for you on the 12th (final) month when all prior instalments are paid on time.",
      "4. Redemption: Use your accumulated total (paid + bonus) to purchase any gold jewellery design from our showroom.",
      "5. Contact: 9591691619 or 9108265311 · Visit us at K.R. Nagar.",
    ].join("\n"),
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
    Counter,
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

async function main() {
  await connectDatabase();
  await wipeTenant(DEMO.tenantCode);

  const growthPlan =
    (await SubscriptionPlan.findOne({ tier: PlanTier.GROWTH, active: true }).lean()) ??
    (await SubscriptionPlan.findById("splan_growth").lean());
  const planFeaturesSnapshot = {
    ...DEFAULT_PLAN_FEATURES[PlanTier.GROWTH],
    ecommerce: false,
    ecommercePayments: false,
    digitalMetals: false,
  };

  const tenantId = createId("tenant");
  const branchId = createId("branch");
  const ownerId = createId("user");
  const passwordHash = await argon2.hash(DEMO.ownerPassword, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  const ownerMobile10 = DEMO.ownerMobile.replace(/\D/g, "").slice(-10);
  const mobileE164 = DEMO.ownerMobile.startsWith("+")
    ? DEMO.ownerMobile
    : `+91${ownerMobile10}`;

  await Tenant.create({
    _id: tenantId,
    code: DEMO.tenantCode,
    name: DEMO.tenantName,
    displayName: DEMO.displayName,
    mobile: mobileE164,
    supportNumber: `${DEMO.supportPhones[0]} / ${DEMO.supportPhones[1]}`,
    status: TenantStatus.ACTIVE,
    goLiveAt: new Date(),
    address: {
      line1: DEMO.showroomLine,
      city: DEMO.city,
      state: DEMO.state,
    },
    branding: { displayName: DEMO.displayName },
    settings: {
      requireKycForEnrolment: false,
      oneActiveSchemePerCustomer: false,
      customerAppMaintenance: false,
    },
    operations: {
      multiSchemePerCustomer: false,
      receiptPrefix: "EK",
      customerSelfEnrolEnabled: true,
      customerSelfRegistrationEnabled: true,
      customerAppWriteEnabled: true,
      customerAppPaymentsEnabled: true,
      ecommerceEnabled: false,
      digitalMetalsEnabled: false,
      termsAndConditions: "Ekta Gold Chitti scheme terms.",
    },
    featureFlags: {
      customerAppEnabled: true,
      customerSelfEnrol: true,
      staffAppEnabled: true,
      onlinePayments: true,
      flexibleScheme: false,
      goldWeightScheme: false,
    },
    subscription: {
      tier: PlanTier.GROWTH,
      status: "ACTIVE",
      planId: growthPlan?._id ?? "splan_growth",
      billingCycle: BillingCycle.MONTHLY,
      startsAt: new Date(),
      renewsAt: new Date(Date.now() + 365 * 86_400_000),
      limits: {
        ...(growthPlan?.limits ?? {}),
        activeCustomers: 500,
        branches: 2,
        staff: 10,
        schemePlans: 3,
        whatsappMessages: 2000,
      },
      planFeaturesSnapshot,
      featureOverrides: {},
    },
  });

  const branch = await Branch.create({
    _id: branchId,
    tenantId,
    code: "KRNGAR",
    name: "K.R. Nagar Showroom",
    address: {
      line1: DEMO.showroomLine,
      city: DEMO.city,
      state: DEMO.state,
    },
    isHeadOffice: true,
    active: true,
  });

  await User.create({
    _id: ownerId,
    type: UserType.TENANT_USER,
    tenantId,
    branchId: null,
    role: TenantRole.TENANT_OWNER,
    name: DEMO.ownerName,
    mobile: ownerMobile10,
    passwordHash,
    mustSetPassword: false,
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
    enteredBy: ownerId,
  });

  const plan = await SchemePlan.create({
    _id: createId("plan"),
    tenantId,
    ...goldChittiPlanBody(),
    createdBy: ownerId,
    version: 1,
  });

  const owner = await User.findById(ownerId);
  const DEMO_CUSTOMER_COUNT = 12;
  const demoCustomers = [];
  for (let n = 1; n <= DEMO_CUSTOMER_COUNT; n += 1) {
    const seq = await nextSequence(tenantId, "customer");
    demoCustomers.push(
      await Customer.create({
        _id: createId("customer"),
        tenantId,
        branchId: branch._id,
        customerNumber: `CUS-${String(seq).padStart(6, "0")}`,
        passbookNumber: `PB-${String(seq).padStart(6, "0")}`,
        name: `Ekta Demo ${String(n).padStart(2, "0")}`,
        mobile: `987652${String(n).padStart(4, "0")}`,
        status: CustomerStatus.ACTIVE,
        kyc: { status: "VERIFIED", verifiedAt: new Date() },
      }),
    );
  }

  const ctx = {
    auth: {
      id: owner._id,
      tenantId,
      type: UserType.TENANT_USER,
      role: TenantRole.TENANT_OWNER,
    },
    scope: { tenantId },
    tenant: await Tenant.findById(tenantId),
    baseUrl: "/api/v1/admin",
    headers: { "user-agent": "seed-ekta-gold-chitti" },
    ip: "127.0.0.1",
    body: {},
    query: {},
  };

  console.log("\nSeeding demo customers & enrollments (~1 min)…\n");
  const matrixSummary = await seedEktaGoldChittiDemoMatrix(ctx, {
    plan,
    branchId: branch._id,
    customers: demoCustomers,
  });

  console.log("\n=== Ekta — Gold Chitti tenant ready ===\n");
  console.log(`Tenant code:     ${DEMO.tenantCode}`);
  console.log(`Showroom:        ${DEMO.showroomLine}`);
  console.log(`Customer care:   ${DEMO.supportPhones.join(", ")}`);
  console.log(`Portal login:    tenant ${DEMO.tenantCode} · mobile ${ownerMobile10} · PIN/password ${DEMO.ownerPassword}`);
  console.log(`Plan (only):     ${plan.code} — ${plan.displayName} (12m, 11+1 ONE_FREE_INSTALLMENT)`);
  console.log(`Gold rate:       ₹${(DEMO.goldRatePerGramPaise / 100).toLocaleString("en-IN")}/g 22K for ${today()}`);
  console.log(`Demo customers:  ${demoCustomers.length} (${matrixSummary.length} enrollments / states)\n`);
  console.log("Scenario map (search by customer name in portal):\n");
  for (const row of matrixSummary) {
    const enr = row.enrollment ? ` ${row.enrollment}` : "";
    console.log(`  · ${row.customer}${enr} — ${row.story}`);
  }
  console.log(
    "\nCustomer app OTP login: demo mobiles 9876520001–9876520012 (tenant EKTA).\n",
  );

  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase();
  process.exit(1);
});
