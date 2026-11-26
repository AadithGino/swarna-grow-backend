/**
 * Wavoo Jewellers — Flexi cash savings + Smart gold weight plan, ecommerce catalog, EVOLUXE PG/OTP.
 *
 * Usage: npm run seed:wavoo-jewellers
 * Login: tenant WAVOO · mobile 9847033600 · password 2026
 */
import argon2 from "argon2";
import { pathToFileURL } from "node:url";
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
import { COLLECTION_GOLD_RULES } from "./lib/collection-gold-plan-seed.js";
import { seedJewelleryCollageEcommerce } from "./lib/jewellery-collage-ecommerce.js";
import { copyTenantIntegrationSecrets } from "./lib/copy-tenant-integration-secrets.js";
import {
  Branch,
  GoldRate,
  SchemePlan,
  SubscriptionPlan,
  Tenant,
  User,
} from "../src/models/index.js";

const DEMO = {
  tenantCode: "WAVOO",
  tenantName: "Wavoo Jewellers",
  displayName: "Wavoo Jewellers",
  city: "Chennai",
  ownerName: "Wavoo Admin",
  ownerMobile: process.env.WAVOO_OWNER_MOBILE?.trim() || "9847033600",
  ownerPassword: process.env.WAVOO_OWNER_PASSWORD?.trim() || "2026",
  goldRatePerGramPaise: 720_000,
};

const AVAIL = {
  allBranches: true,
  branchIds: [],
  visibleInCustomerApp: true,
  customerSelfEnrolAllowed: true,
};

const FLEXI_TERMS = `WAVOO FLEXI GOLD SAVINGS PLAN — Terms & Conditions

Customer benefits:
· Choose your preferred monthly savings amount.
· Pay your chosen amount for 11 consecutive months.
· Redeem your accumulated savings towards your desired jewellery purchase in the 12th month.

Terms:
· 100% Wastage Benefit — No Wastage Charges up to 18%.
· Gold will be calculated at the prevailing market price on the date of purchase.
· 3% GST Applicable.`;

const SMART_TERMS = `WAVOO SMART GOLD PLAN — Terms & Conditions

Customer benefits:
· Choose your preferred monthly savings amount.
· Pay 11 monthly instalments.
· Gold weight will be calculated based on the gold rate applicable on each instalment payment day.
· On the 12th month, redeem your accumulated gold weight for your desired jewellery.

Terms:
· 50% Discount on Wastage Charges.
· 3% GST Applicable.`;

/**
 * Spec has no monthly limits: the customer picks any amount. The schema still needs numeric
 * bounds for CUSTOMER_CHOSEN plans, so use the lowest accepted minimum (₹1) and a ceiling far
 * above any realistic instalment. Whole-rupee steps only.
 */
const CHOSEN_AMOUNTS = {
  amountMode: "CUSTOMER_CHOSEN",
  minInstallmentPaise: 100,
  maxInstallmentPaise: 10_000_000_000,
  multipleOfPaise: 100,
};

/** No per-payment minimum, no partial or advance payments: spec says "pay your chosen amount". */
const NO_EXTRA_PAYMENT_RULES = {
  partialPaymentAllowed: false,
  advancePaymentAllowed: false,
  maxAdvanceInstallments: 0,
  minPaymentPaise: null,
  maxPaymentPerTransactionPaise: null,
};

function flexiCashPlan() {
  return validateCompletePlan({
    name: "Wavoo Flexi Gold Savings Plan",
    code: "WAVOOFLEXI",
    displayName: "Wavoo Flexi Gold Savings",
    description:
      "Choose a monthly savings amount; pay for 11 months and redeem towards jewellery in the 12th month.",
    valueBasis: "CASH",
    paymentPattern: PaymentPattern.FIXED,
    durationMonths: 12,
    installmentCount: 11,
    amountRules: { ...CHOSEN_AMOUNTS },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      graceDays: 5,
      firstInstallmentModeDefault: "START_NEXT_CYCLE",
      firstInstallmentModeEditable: true,
    },
    paymentRules: { ...NO_EXTRA_PAYMENT_RULES },
    benefit: {
      type: "TEXT_ONLY",
      textBenefit: "100% Wastage Benefit — No Wastage Charges up to 18%.",
      displayLabel: "100% wastage benefit up to 18%",
      eligibility: { requireAllInstallmentsPaid: true, maxAllowedDefaults: 0, minMonthsCompleted: 0 },
    },
    redemptionRules: {
      prematureClosureAllowed: false,
      lockInMonths: 0,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 0, benefitTreatment: "FORFEIT" },
      allowedModes: ["PURCHASE_ADJUSTMENT"],
      redeemAtAnyBranch: true,
    },
    availability: AVAIL,
    termsText: FLEXI_TERMS,
    status: SchemePlanStatus.ACTIVE,
  });
}

function smartGoldPlan() {
  return validateCompletePlan({
    name: "Wavoo Smart Gold Plan",
    code: "WAVOOSMART",
    displayName: "Wavoo Smart Gold Plan",
    description:
      "Monthly instalments convert to gold weight at each payment day's rate; redeem accumulated gold weight in the 12th month.",
    valueBasis: "GOLD_WEIGHT",
    paymentPattern: PaymentPattern.FIXED,
    durationMonths: 12,
    installmentCount: 11,
    amountRules: { ...CHOSEN_AMOUNTS },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      graceDays: 5,
      firstInstallmentModeDefault: "START_NEXT_CYCLE",
      firstInstallmentModeEditable: true,
    },
    paymentRules: { ...NO_EXTRA_PAYMENT_RULES },
    goldRules: COLLECTION_GOLD_RULES,
    benefit: {
      type: "TEXT_ONLY",
      textBenefit: "50% Discount on Wastage Charges.",
      displayLabel: "50% discount on wastage charges",
      eligibility: { requireAllInstallmentsPaid: true, maxAllowedDefaults: 0, minMonthsCompleted: 0 },
    },
    redemptionRules: {
      prematureClosureAllowed: false,
      lockInMonths: 0,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 0, benefitTreatment: "FORFEIT" },
      allowedModes: ["PURCHASE_ADJUSTMENT"],
      redeemAtAnyBranch: true,
    },
    availability: AVAIL,
    termsText: SMART_TERMS,
    status: SchemePlanStatus.ACTIVE,
  });
}

async function wipeTenant(code) {
  const existing = await Tenant.findOne({ code }).lean();
  if (!existing) return;
  const tenantId = existing._id;
  const models = await import("../src/models/index.js");
  await models.LedgerEntry.collection.deleteMany({ tenantId });
  const deletable = [
    models.Payment,
    models.PaymentIntent,
    models.PaymentLink,
    models.Scheme,
    models.Redemption,
    models.Customer,
    models.SchemePlan,
    models.GoldRate,
    models.EcommerceProduct,
    models.EcommerceCategory,
    models.EcommerceInventory,
    models.EcommerceBanner,
    models.Upload,
  ];
  for (const Model of deletable) {
    await Model.deleteMany({ tenantId });
  }
  await User.deleteMany({ tenantId, type: UserType.TENANT_USER });
  await Branch.deleteMany({ tenantId });
  await models.Counter.deleteMany({ _id: { $regex: `^${tenantId}:` } });
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
    ecommerce: true,
    ecommercePayments: true,
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

  await Tenant.create({
    _id: tenantId,
    code: DEMO.tenantCode,
    name: DEMO.tenantName,
    displayName: DEMO.displayName,
    mobile: `+91${ownerMobile10}`,
    supportNumber: ownerMobile10,
    email: "store@wavoojewellers.example",
    status: TenantStatus.ACTIVE,
    goLiveAt: new Date(),
    address: {
      line1: "Wavoo Jewellers Showroom",
      city: DEMO.city,
      state: "Tamil Nadu",
      pincode: "600001",
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
      receiptPrefix: "WV",
      customerSelfEnrolEnabled: true,
      customerSelfRegistrationEnabled: true,
      customerAppWriteEnabled: true,
      customerAppPaymentsEnabled: true,
      ecommerceEnabled: true,
      ecommercePaymentsRolloutEnabled: true,
      digitalMetalsEnabled: false,
      termsAndConditions: "Wavoo Gold Savings Scheme — see enrolled plan for terms.",
    },
    featureFlags: {
      customerAppEnabled: true,
      customerSelfEnrol: true,
      staffAppEnabled: true,
      onlinePayments: true,
      flexibleScheme: false,
      goldWeightScheme: true,
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
        schemePlans: 10,
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
    name: "Wavoo Main",
    address: { line1: "Showroom", city: DEMO.city, state: "Tamil Nadu", pincode: "600001" },
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

  for (const body of [flexiCashPlan(), smartGoldPlan()]) {
    await SchemePlan.create({
      _id: createId("plan"),
      tenantId,
      ...body,
      createdBy: owner._id,
      version: 1,
    });
  }

  const { phonepe, messageCentral } = await copyTenantIntegrationSecrets({
    sourceCode: "EVOLUXE",
    targetCode: DEMO.tenantCode,
    preserveTargetEcommerce: true,
  });

  const catalog = await seedJewelleryCollageEcommerce({
    tenantCode: DEMO.tenantCode,
    slugPrefix: "wavoo-",
    skuPrefix: "WAV-",
    seedTag: "wavoo-catalog-v1",
    bannerKeyPrefix: "wavoo-banner:",
    brandLabel: DEMO.displayName,
    registeredState: "Tamil Nadu",
    uploadFilePrefix: "wavoo",
    skipBanners: false,
  });

  console.log("\n=== Wavoo Jewellers ready ===\n");
  console.log(`Tenant code:  ${DEMO.tenantCode}`);
  console.log(`Portal login: ${ownerMobile10} / ${DEMO.ownerPassword}`);
  console.log(`Branch:       ${branch.name}, ${DEMO.city}`);
  console.log(`Plans:        WAVOOFLEXI (cash flexi 11+1 month) · WAVOOSMART (gold weight 11 months)`);
  console.log(
    `Integrations: PhonePe ${phonepe?.environment ?? "—"} · OTP ${messageCentral?.customerId ? "Message Central" : "env fallback"}`,
  );
  console.log(
    `Ecommerce:    ${catalog.products} products, ${catalog.categories} categories, ${catalog.imageUploads} images`,
  );
  console.log(`Customer app: /customer/wavoo/login\n`);

  await disconnectDatabase();
}

export const WAVOO_TENANT_CODE = DEMO.tenantCode;
export { flexiCashPlan, smartGoldPlan };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(async (err) => {
    console.error(err);
    await disconnectDatabase();
    process.exit(1);
  });
}