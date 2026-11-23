/**
 * Seed the three Aira collection plans and the upfront gold plan for the demo tenant.
 * Usage: node --env-file=.env scripts/seed-aira-gold.js
 * Demo databases only. Re-running replaces the AIRAGOLD tenant and its data.
 */
import argon2 from "argon2";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  BillingCycle,
  CustomerStatus,
  PlanTier,
  TenantRole,
  TenantStatus,
  UserStatus,
  UserType,
} from "../src/constants/enums.js";
import { DEFAULT_PLAN_FEATURES } from "../src/constants/plan-features.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { createId } from "../src/lib/ids.js";
import { today } from "../src/lib/date.js";
import {
  buildAiraCollectionPlan,
  buildAiraUpfrontPlan,
  STANDARD_COLLECTION_PLAN_DEFS,
} from "./lib/collection-gold-plan-seed.js";
import { enrol } from "../src/services/scheme.service.js";
import { validateCompletePlan } from "../src/lib/plan-merge.js";
import { Branch, Customer, GoldRate, SchemePlan, SubscriptionPlan, Tenant, User } from "../src/models/index.js";
import { nextSequence } from "../src/services/sequence.service.js";

const DEMO = {
  tenantCode: "AIRAGOLD",
  tenantName: "Aira Gold",
  displayName: "Aira Gold",
  city: "Kerala",
  ownerName: "Aira Gold Admin",
  ownerMobile: process.env.AIRAGOLD_OWNER_MOBILE?.trim() || "9876501234",
  ownerPassword: process.env.AIRAGOLD_OWNER_PASSWORD?.trim() || "4321",
  goldRatePerGramPaise: 720_000,
};

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

  const mobileE164 = DEMO.ownerMobile.startsWith("+")
    ? DEMO.ownerMobile
    : `+91${DEMO.ownerMobile.replace(/\D/g, "")}`;

  await Tenant.create({
    _id: tenantId,
    code: DEMO.tenantCode,
    name: DEMO.tenantName,
    displayName: DEMO.displayName,
    mobile: mobileE164,
    supportNumber: DEMO.ownerMobile.replace(/\D/g, "").slice(-10),
    status: TenantStatus.ACTIVE,
    goLiveAt: new Date(),
    address: { line1: "Aira Gold Showroom", city: DEMO.city, state: "Kerala" },
    branding: {
      displayName: DEMO.displayName,
      primaryColor: "#8B6914",
      accentColor: "#D4AF37",
    },
    settings: {
      requireKycForEnrolment: false,
      oneActiveSchemePerCustomer: false,
      customerAppMaintenance: false,
    },
    operations: {
      multiSchemePerCustomer: true,
      receiptPrefix: "AG",
      customerSelfEnrolEnabled: true,
      customerSelfRegistrationEnabled: true,
      customerAppWriteEnabled: true,
      customerAppPaymentsEnabled: true,
      ecommerceEnabled: false,
      digitalMetalsEnabled: false,
      termsAndConditions: "Aira Gold collection and investment plan terms.",
    },
    featureFlags: {
      customerAppEnabled: true,
      customerSelfEnrol: true,
      staffAppEnabled: true,
      onlinePayments: true,
      flexibleScheme: true,
      goldWeightScheme: true,
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
        activeCustomers: 1000,
        branches: 2,
        staff: 10,
        schemePlans: 10,
        whatsappMessages: 5000,
      },
      planFeaturesSnapshot: planFeaturesSnapshot,
      featureOverrides: {},
    },
  });

  const branch = await Branch.create({
    _id: branchId,
    tenantId,
    code: "MAIN",
    name: "Aira Gold Main",
    address: { line1: "Aira Gold Showroom", city: DEMO.city, state: "Kerala" },
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
    mobile: DEMO.ownerMobile.replace(/\D/g, "").slice(-10),
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

  const planDefs = [
    ...STANDARD_COLLECTION_PLAN_DEFS.map(buildAiraCollectionPlan),
    buildAiraUpfrontPlan({ maximumUpfrontPaise: 50_000_000 }),
  ].map(validateCompletePlan);

  const plans = [];
  for (const body of planDefs) {
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

  const DEMO_CUSTOMER_COUNT = plans.reduce((count, plan) => count + (plan.collectionRules?.frequencies.length ?? 1) * 2, 0);
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
        name: `Aira Demo ${String(n).padStart(2, "0")}`,
        mobile: `987651${String(n).padStart(4, "0")}`,
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
    headers: { "user-agent": "seed-aira-gold" },
    ip: "127.0.0.1",
    body: {},
    query: {},
  };

  console.log("\nSeeding demo customers & enrollments (~1–3 min)…\n");
  const matrixSummary = [];
  let customerIndex = 0;
  for (const plan of plans) {
    const installmentAmountPaise = plan.oneTimeRules ? plan.amountRules.minInstallmentPaise : 200_000;
    for (const collectionFrequency of plan.collectionRules?.frequencies ?? [undefined]) {
      for (const paid of [false, true]) {
        const customer = demoCustomers[customerIndex++];
        const scheme = await enrol({
          ...ctx,
          body: {
            customerId: customer._id, planId: plan._id, branchId: branch._id,
            ...(collectionFrequency ? { collectionFrequency } : {}),
            installmentAmountPaise, firstInstallmentMode: "COLLECT_NOW",
            ...(paid ? { firstInstallmentAction: "RECORD_MANUAL_PAYMENT", payment: { amountPaise: installmentAmountPaise, mode: "UPI" } } : {}),
          },
        });
        matrixSummary.push({
          customer: customer.name,
          enrollment: scheme.enrollmentNumber,
          story: `${plan.code} · ${collectionFrequency ?? "UPFRONT"} · ${scheme.status}`,
        });
      }
    }
  }

  console.log("\n=== Aira Gold tenant ready ===\n");
  console.log(`Tenant code:     ${DEMO.tenantCode}`);
  console.log(`Display name:    ${DEMO.displayName}`);
  console.log(`Branch:          ${branch.name}`);
  console.log(`Portal login:    tenant ${DEMO.tenantCode} · mobile ${owner.mobile} · password ${DEMO.ownerPassword}`);
  console.log(`Subscription:    Growth (customer self-enrol, flexible + gold schemes; no ecommerce/digital metals)`);
  console.log(`Gold rate:       ₹${(DEMO.goldRatePerGramPaise / 100).toLocaleString("en-IN")}/g 22K for ${today()}\n`);
  console.log("Active scheme plans:");
  for (const p of plans) {
    const bonus = p.oneTimeRules ? "2% principal gold credited each month" : p.benefit.displayLabel;
    console.log(`  · ${p.code} — ${p.displayName ?? p.name} (${p.durationMonths}m lock-in) — ${bonus}`);
  }
  console.log(`Demo customers:  ${demoCustomers.length} (${matrixSummary.length} enrollments / states)\n`);
  console.log("Scenario map (search by customer name in portal):\n");
  for (const row of matrixSummary) {
    const enr = row.enrollment ? ` ${row.enrollment}` : "";
    console.log(`  · ${row.customer}${enr} — ${row.story}`);
  }
  console.log(
    "\nCustomer app OTP login: use demo mobile 9876510001–9876510020 (tenant AIRAGOLD).\n" +
      "Daily, Weekly, or Monthly is selected during enrolment.\n",
  );

  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase();
  process.exit(1);
});
