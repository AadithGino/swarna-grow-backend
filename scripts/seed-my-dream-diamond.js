/**
 * My Dream Diamond — demo jeweller: fixed ₹5,000/month scheme, ecommerce catalog, scheme lifecycle matrix.
 *
 * Usage: npm run seed:my-dream-diamond
 * Login: tenant MYDREAM · mobile 9847033300 · password 2026
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
import {
  Branch,
  Counter,
  Customer,
  EcommerceBanner,
  EcommerceCategory,
  EcommerceInventory,
  EcommerceProduct,
  LedgerEntry,
  Payment,
  PaymentIntent,
  PaymentLink,
  Redemption,
  Scheme,
  SchemePlan,
  SubscriptionPlan,
  Tenant,
  Upload,
  User,
} from "../src/models/index.js";
import { nextSequence } from "../src/services/sequence.service.js";
import { seedCollectionPlanMatrix } from "./seed-aira-gold-matrix.js";
import { seedJewelleryCollageEcommerce } from "./lib/jewellery-collage-ecommerce.js";
import { seedMyDreamDiamondBanners } from "./lib/mydream-banner-seed.js";

const DEMO = {
  tenantCode: "MYDREAM",
  tenantName: "My Dream Diamond",
  displayName: "My Dream Diamond",
  city: "Kochi",
  ownerMobile: "9847033300",
  ownerPassword: "2026",
};

const INSTALLMENT_PAISE = 500_000;

const CUSTOMER_APP_AVAILABILITY = {
  allBranches: true,
  branchIds: [],
  visibleInCustomerApp: true,
  customerSelfEnrolAllowed: true,
};

function dreamDiamond5000PlanBody() {
  return {
    name: "Dream Diamond 5000",
    code: "MDD5K11P1",
    displayName: "₹5,000 Monthly (11+1)",
    description:
      "Fixed ₹5,000 per month for 11 months; on maturity the jeweller credits one free instalment as purchase benefit.",
    valueBasis: "CASH",
    paymentPattern: PaymentPattern.FIXED,
    durationMonths: 11,
    installmentCount: 11,
    amountRules: {
      amountMode: "JEWELLER_FIXED",
      fixedAmountPaise: INSTALLMENT_PAISE,
      minInstallmentPaise: INSTALLMENT_PAISE,
      maxInstallmentPaise: INSTALLMENT_PAISE,
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
      minPaymentPaise: INSTALLMENT_PAISE,
      maxPaymentPerTransactionPaise: INSTALLMENT_PAISE * 3,
    },
    benefit: {
      type: "ONE_FREE_INSTALLMENT",
      displayLabel: "One free ₹5,000 month on maturity",
      eligibility: { requireAllInstallmentsPaid: true, maxAllowedDefaults: 0, minMonthsCompleted: 0 },
    },
    redemptionRules: {
      prematureClosureAllowed: true,
      lockInMonths: 3,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 5, benefitTreatment: "FORFEIT" },
      allowedModes: ["CASH", "PURCHASE_ADJUSTMENT"],
      redeemAtAnyBranch: true,
    },
    availability: CUSTOMER_APP_AVAILABILITY,
    termsText:
      "1. Pay ₹5,000 on the due date each month for 11 months.\n2. When all instalments are paid, My Dream Diamond credits one additional ₹5,000 month toward jewellery purchase.\n3. Redemption via bill adjustment or cash as per store policy.",
    status: SchemePlanStatus.ACTIVE,
  };
}

async function wipeTenant(code) {
  const existing = await Tenant.findOne({ code }).lean();
  if (!existing) return;
  const tenantId = existing._id;
  await LedgerEntry.collection.deleteMany({ tenantId });
  for (const Model of [
    Payment,
    PaymentIntent,
    PaymentLink,
    Scheme,
    Redemption,
    Customer,
    SchemePlan,
    EcommerceProduct,
    EcommerceCategory,
    EcommerceInventory,
    EcommerceBanner,
    Upload,
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
    headers: { "user-agent": "seed-my-dream-diamond" },
    ip: "127.0.0.1",
    body: {},
    query: {},
  };
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
    flexibleScheme: false,
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

  const mobileE164 = `+91${DEMO.ownerMobile}`;

  const tenant = await Tenant.create({
    _id: tenantId,
    code: DEMO.tenantCode,
    name: DEMO.tenantName,
    displayName: DEMO.displayName,
    mobile: mobileE164,
    supportNumber: DEMO.ownerMobile,
    email: "demo@mydreamdiamond.in",
    status: TenantStatus.ACTIVE,
    address: {
      line1: "MG Road",
      city: DEMO.city,
      state: "Kerala",
      pincode: "682001",
    },
    branding: {
      primaryColor: "#1A237E",
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
      receiptPrefix: "MDD",
      customerSelfEnrolEnabled: true,
      customerSelfRegistrationEnabled: true,
      customerAppWriteEnabled: true,
      customerAppPaymentsEnabled: true,
      ecommerceEnabled: true,
      termsAndConditions: "My Dream Diamond — scheme and ecommerce terms as per enrolled plan.",
    },
    featureFlags: {
      customerAppEnabled: true,
      customerSelfEnrol: true,
      staffAppEnabled: false,
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
        staff: 8,
        schemePlans: 5,
        whatsappMessages: 2000,
      },
      planFeaturesSnapshot,
      featureOverrides: {},
    },
  });

  const branch = await Branch.create({
    _id: branchId,
    tenantId,
    code: "KCH",
    name: "Kochi Showroom",
    address: { line1: "MG Road", city: DEMO.city, pincode: "682001" },
    isHeadOffice: true,
    active: true,
  });

  const owner = await User.create({
    _id: ownerId,
    type: UserType.TENANT_USER,
    tenantId,
    branchId: null,
    role: TenantRole.TENANT_OWNER,
    name: "My Dream Diamond Admin",
    mobile: DEMO.ownerMobile,
    passwordHash,
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.TENANT_OWNER],
  });

  const plan = await SchemePlan.create({
    _id: createId("plan"),
    tenantId,
    ...dreamDiamond5000PlanBody(),
    createdBy: owner._id,
    version: 1,
  });

  const ctx = makeCtx(tenant, owner);

  const CUSTOMER_ROWS = [
    { name: "Anjali Menon", mobile: "9847033301" },
    { name: "Suresh Nair", mobile: "9847033302" },
    { name: "Priya Krishnan", mobile: "9847033303" },
    { name: "Ramesh Iyer", mobile: "9847033304" },
    { name: "Lakshmi Devi", mobile: "9847033305" },
    { name: "Vijay Kumar", mobile: "9847033306" },
    { name: "Meera Unni", mobile: "9847033307" },
    { name: "Gopal Menon", mobile: "9847033308" },
    { name: "Deepa Nambiar", mobile: "9847033309" },
    { name: "Arun Pillai", mobile: "9847033310" },
    { name: "Sneha Raj", mobile: "9847033311" },
    { name: "Kiran Das", mobile: "9847033312" },
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

  console.log("\nSeeding scheme enrollments (backdated payments; ~1–3 min)…\n");
  const matrixSummary = await seedCollectionPlanMatrix(ctx, {
    plan,
    planLabel: "₹5,000 / month (11+1)",
    branchId: branch._id,
    customers,
    installmentAmountPaise: INSTALLMENT_PAISE,
  });

  console.log("\nSeeding ecommerce catalog (JPEG uploads)…\n");
  const catalog = await seedJewelleryCollageEcommerce({
    tenantCode: DEMO.tenantCode,
    slugPrefix: "mydream-jewel-",
    skuPrefix: "MDD-",
    seedTag: "my-dream-diamond-catalog-v1",
    bannerKeyPrefix: "mydream-jewel-banner:",
    brandLabel: DEMO.displayName,
    registeredState: "Kerala",
    uploadFilePrefix: "mydream",
    skipBanners: true,
  });

  console.log("\nSeeding home + shop promo banners…\n");
  const bannerResult = await seedMyDreamDiamondBanners();

  console.log("\n=== My Dream Diamond demo ready ===\n");
  console.log(`Tenant code:  ${DEMO.tenantCode}`);
  console.log(`Portal login: ${DEMO.ownerMobile} / ${DEMO.ownerPassword}`);
  console.log(`Branch:       ${branch.name}, ${DEMO.city}`);
  console.log(`Plan:         ${plan.code} — fixed ₹5,000/month × 11 + 1 free month benefit`);
  console.log(`Customers:    ${customers.length} with ${matrixSummary.length} scenario enrollments`);
  console.log(
    `Ecommerce:    ${catalog.products} products, ${catalog.categories} categories, ${catalog.imageUploads} product images, ${bannerResult.banners.length} promo banners`,
  );
  console.log("\nScenario map (search by customer name in portal):\n");
  for (const row of matrixSummary) {
    const enr = row.enrollment ? ` ${row.enrollment}` : "";
    console.log(`  · ${row.customer}${enr} — ${row.story}`);
  }
  console.log("\nCustomer app: OTP login with mobiles 9847033301–3312.");
  console.log("Customer shop: /customer/mydream/shop\n");

  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase();
  process.exit(1);
});