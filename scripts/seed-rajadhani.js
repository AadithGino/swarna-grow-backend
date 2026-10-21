/**
 * Rajadhani — gold schemes (Growth): Swarna / Akshaya / Tritiya collection plans.
 *
 * Usage: node --env-file=.env scripts/seed-rajadhani.js
 * Re-run: replaces tenant RAJADHANI if it already exists.
 */
import argon2 from "argon2";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  BillingCycle,
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
  buildCollectionGoldPlan,
  STANDARD_COLLECTION_PLAN_DEFS,
} from "./lib/collection-gold-plan-seed.js";
import { Branch, GoldRate, SchemePlan, SubscriptionPlan, Tenant, User } from "../src/models/index.js";

const DEMO = {
  tenantCode: "RAJADHANI",
  tenantName: "Rajadhani",
  displayName: "Rajadhani",
  city: "Kerala",
  ownerName: "Rajadhani Admin",
  ownerMobile: process.env.RAJADHANI_OWNER_MOBILE?.trim() || "9876543210",
  ownerPassword: process.env.RAJADHANI_OWNER_PASSWORD?.trim() || "4321",
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
    address: { line1: "Main Showroom", city: DEMO.city, state: "Kerala" },
    branding: { displayName: DEMO.displayName },
    settings: {
      requireKycForEnrolment: false,
      oneActiveSchemePerCustomer: false,
      customerAppMaintenance: false,
    },
    operations: {
      multiSchemePerCustomer: true,
      receiptPrefix: "RJ",
      customerSelfEnrolEnabled: true,
      customerSelfRegistrationEnabled: true,
      customerAppWriteEnabled: true,
      customerAppPaymentsEnabled: true,
      ecommerceEnabled: false,
      digitalMetalsEnabled: false,
      termsAndConditions: "Rajadhani gold savings scheme terms.",
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
    name: "Rajadhani Main",
    address: { line1: "Main Showroom", city: DEMO.city, state: "Kerala" },
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

  const plans = [];
  for (const def of STANDARD_COLLECTION_PLAN_DEFS) {
    plans.push(
      await SchemePlan.create({
        _id: createId("plan"),
        tenantId,
        ...buildCollectionGoldPlan(def),
        createdBy: owner._id,
        version: 1,
      }),
    );
  }

  console.log("\n=== Rajadhani tenant ready (Growth + collection plans) ===\n");
  console.log(`Tenant code:     ${DEMO.tenantCode}`);
  console.log(`Display name:    ${DEMO.displayName}`);
  console.log(`Branch:          ${branch.name}`);
  console.log(`Portal login:    tenant ${DEMO.tenantCode} · mobile ${owner.mobile} · password ${DEMO.ownerPassword}`);
  console.log(`Subscription:    Growth (customer self-enrol; no ecommerce/digital metals)`);
  console.log(`Gold rate:       ₹${(DEMO.goldRatePerGramPaise / 100).toLocaleString("en-IN")}/g 22K for ${today()}\n`);
  console.log("Active scheme plans:");
  for (const p of plans) {
    console.log(
      `  · ${p.code} — ${p.displayName ?? p.name} (${p.durationMonths}m) — ${p.benefit?.bonusValue}% maturity (total)`,
    );
  }
  console.log("");

  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase();
  process.exit(1);
});
