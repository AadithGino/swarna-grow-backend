/**
 * Happy Gold — Gold Jewellery Savings Scheme (11 pay + 1 bonus month), ecommerce off.
 *
 * Usage: npm run seed:happy-gold
 * Login: tenant HAPPYGOLD · mobile 9847033500 · password 2026
 */
import argon2 from "argon2";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  BillingCycle,
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
import { validateCompletePlan } from "../src/lib/plan-merge.js";
import { today } from "../src/lib/date.js";
import { Branch, GoldRate, SchemePlan, SubscriptionPlan, Tenant, User } from "../src/models/index.js";
import { copyTenantIntegrationSecrets } from "./lib/copy-tenant-integration-secrets.js";

const DEMO = {
  tenantCode: "HAPPYGOLD",
  tenantName: "Happy Gold",
  displayName: "Happy Gold",
  city: "Kochi",
  ownerName: "Happy Gold Admin",
  ownerMobile: process.env.HAPPYGOLD_OWNER_MOBILE?.trim() || "9847033500",
  ownerPassword: process.env.HAPPYGOLD_OWNER_PASSWORD?.trim() || "2026",
  goldRatePerGramPaise: 725_000,
};

const CUSTOMER_APP_AVAILABILITY = {
  allBranches: true,
  branchIds: [],
  visibleInCustomerApp: true,
  customerSelfEnrolAllowed: true,
};

const HAPPY_GOLD_TERMS = `Happy Gold — Gold Jewellery Savings Scheme

Membership and payments
· Multiple memberships are allowed.
· Pay the full monthly instalment on time each month (you may make several smaller payments within a month to reach the required amount).
· If the full plan amount is not paid in any month during the 11-month term, Happy Gold's one-instalment contribution will not apply. Only amounts you actually paid can be used toward gold jewellery.

Maturity and redemption
· No extra contribution on premature closure.
· Redemption is permitted one month after the last (11th) instalment.
· Gold jewellery only — not coins or bars.
· The account holder must visit in person with the digital passbook and valid ID.
· No cash redemption — scheme value is applied toward a jewellery purchase.

Pricing
· Gold rate, making charges and GST apply to the jewellery bill. The eligible scheme value is applied toward that bill.`;

/** Monthly instalment in rupees → plan row */
const PLAN_TIERS = [
  { code: "HG11M500", rupees: 500, slug: "500" },
  { code: "HG11M1K", rupees: 1_000, slug: "1k" },
  { code: "HG11M1500", rupees: 1_500, slug: "1500" },
  { code: "HG11M2K", rupees: 2_000, slug: "2k" },
  { code: "HG11M2500", rupees: 2_500, slug: "2500" },
  { code: "HG11M4K", rupees: 4_000, slug: "4k" },
  { code: "HG11M5K", rupees: 5_000, slug: "5k" },
  { code: "HG11M10K", rupees: 10_000, slug: "10k" },
  { code: "HG11M25K", rupees: 25_000, slug: "25k" },
];

function formatInr(rupees) {
  return `₹${rupees.toLocaleString("en-IN")}`;
}

function buildPlanBody({ code, rupees }) {
  const installmentPaise = rupees * 100;
  const totalPay = rupees * 11;
  const totalRedeem = rupees * 12;
  return {
    name: `Happy Gold ${formatInr(rupees)} / month`,
    code,
    displayName: `${formatInr(rupees)} monthly · 11+1`,
    description:
      `Pay ${formatInr(rupees)} every month for 11 months; Happy Gold adds one ${formatInr(rupees)} instalment when you redeem toward jewellery (${formatInr(totalPay)} + ${formatInr(rupees)} = ${formatInr(totalRedeem)}).`,
    valueBasis: "CASH",
    paymentPattern: PaymentPattern.FIXED,
    durationMonths: 12,
    installmentCount: 11,
    amountRules: {
      amountMode: "JEWELLER_FIXED",
      fixedAmountPaise: installmentPaise,
      minInstallmentPaise: installmentPaise,
      maxInstallmentPaise: installmentPaise,
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
      minPaymentPaise: 10_000,
      maxPaymentPerTransactionPaise: installmentPaise,
    },
    benefit: {
      type: "ONE_FREE_INSTALLMENT",
      displayLabel: `One free ${formatInr(rupees)} month on maturity`,
      eligibility: {
        requireAllInstallmentsPaid: true,
        maxAllowedDefaults: 0,
        minMonthsCompleted: 0,
      },
    },
    redemptionRules: {
      prematureClosureAllowed: true,
      lockInMonths: 0,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 0, benefitTreatment: "FORFEIT" },
      allowedModes: ["PURCHASE_ADJUSTMENT"],
      redeemAtAnyBranch: true,
    },
    availability: CUSTOMER_APP_AVAILABILITY,
    termsText: HAPPY_GOLD_TERMS,
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
    customerSelfEnrol: true,
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
  const mobileE164 = ownerMobile10.startsWith("+") ? ownerMobile10 : `+91${ownerMobile10}`;

  await Tenant.create({
    _id: tenantId,
    code: DEMO.tenantCode,
    name: DEMO.tenantName,
    displayName: DEMO.displayName,
    mobile: mobileE164,
    supportNumber: ownerMobile10,
    email: "store@happygold.example",
    status: TenantStatus.ACTIVE,
    goLiveAt: new Date(),
    address: {
      line1: "Happy Gold Showroom",
      city: DEMO.city,
      state: "Kerala",
      pincode: "682001",
    },
    branding: {
      displayName: DEMO.displayName,
      primaryColor: "#B8860B",
      accentColor: "#D4AF37",
    },
    settings: {
      requireKycForEnrolment: false,
      oneActiveSchemePerCustomer: false,
      customerAppMaintenance: false,
    },
    operations: {
      multiSchemePerCustomer: true,
      receiptPrefix: "HG",
      customerSelfEnrolEnabled: true,
      customerSelfRegistrationEnabled: true,
      customerAppWriteEnabled: true,
      customerAppPaymentsEnabled: true,
      ecommerceEnabled: false,
      ecommercePaymentsRolloutEnabled: false,
      digitalMetalsEnabled: false,
      termsAndConditions: HAPPY_GOLD_TERMS,
    },
    featureFlags: {
      customerAppEnabled: true,
      customerSelfEnrol: true,
      staffAppEnabled: true,
      onlinePayments: true,
      flexibleScheme: false,
      passbookImageOnPayment: false,
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
        branches: 3,
        staff: 10,
        schemePlans: 15,
        whatsappMessages: 2000,
      },
      planFeaturesSnapshot,
      featureOverrides: {},
    },
  });

  const branch = await Branch.create({
    _id: branchId,
    tenantId,
    code: "MAIN",
    name: "Happy Gold Main",
    address: { line1: "Showroom", city: DEMO.city, state: "Kerala", pincode: "682001" },
    isHeadOffice: true,
    active: true,
  });

  const owner = await User.create({
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
    enteredBy: owner._id,
  });

  const plans = [];
  for (const tier of PLAN_TIERS) {
    const body = validateCompletePlan(buildPlanBody(tier));
    plans.push(
      await SchemePlan.create({
        _id: createId("plan"),
        tenantId,
        ...body,
        createdBy: owner._id,
        version: 1,
      }),
    );
  }

  console.log("\n=== Happy Gold demo ready ===\n");
  console.log(`Tenant code:  ${DEMO.tenantCode}`);
  console.log(`Portal login: ${ownerMobile10} / ${DEMO.ownerPassword}`);
  console.log(`Branch:       ${branch.name}, ${DEMO.city}`);
  console.log(`Ecommerce:    off`);
  console.log(`Scheme plans: ${plans.length} (11 instalments + 1-month maturity tail, grace 5 days)\n`);
  for (const p of plans) {
    const rupees = p.amountRules.fixedAmountPaise / 100;
    console.log(`  · ${p.code} — ${formatInr(rupees)}/month → ${formatInr(rupees * 12)} redemption value`);
  }

  try {
    const { phonepe, messageCentral } = await copyTenantIntegrationSecrets({
      sourceCode: "EVOLUXE",
      targetCode: DEMO.tenantCode,
      preserveTargetEcommerce: true,
    });
    console.log("\nIntegrations: copied PhonePe + OTP from EVOLUXE");
    console.log(`  PhonePe: ${phonepe.environment ?? "—"} · ${messageCentral?.customerId ? "Message Central configured" : "OTP via global .env"}`);
  } catch (integrationErr) {
    console.warn(
      `\nIntegrations: skipped (${integrationErr.message ?? integrationErr}). ` +
        "Run npm run patch:happygold-integrations-from-evoluxe after EVOLUXE PhonePe/OTP is configured.",
    );
  }

  console.log("\nCustomer app: /customer/happygold/login · self-enrol on any plan above.\n");

  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase();
  process.exit(1);
});