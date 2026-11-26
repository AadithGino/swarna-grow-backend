/**
 * Convert Shazana (SHAZANAGOLDD) from Demo Builder clone → live jewellery tenant:
 * wipes customers, schemes, payments, and all scheme plans; keeps tenant + branches + branding.
 * Seeds only the Flex 6+5 (FLEXI11) cash plan; copies PhonePe + Message Central from EVOLUXE.
 * Disables the linked DemoInstance and clears demo entry pointers.
 *
 *   npm run convert:shazana-proper-jewellery
 *
 * Optional env:
 *   SHAZANA_OWNER_MOBILE=9700041413
 *   SHAZANA_OWNER_PASSWORD=2026
 *   SHAZANA_GOLD_RATE_PAISE=725000
 *   SOURCE_TENANT_CODE=EVOLUXE
 *   TENANT_CODE=SHAZANAGOLDD
 */
import argon2 from "argon2";
import process from "node:process";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  BillingCycle,
  DemoInstanceStatus,
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
import { Branch, DemoInstance, GoldRate, SchemePlan, SubscriptionPlan, Tenant, User } from "../src/models/index.js";
import { buildFlex65FixedCapCashPlan } from "./lib/flex-6-5-fixed-cap-plan.js";
import { copyTenantIntegrationSecrets } from "./lib/copy-tenant-integration-secrets.js";

const DEFAULT_TENANT_CODE = "SHAZANAGOLDD";
const FLEX_CODE = "FLEXI11";
const INTEGRATION_SOURCE = (process.env.SOURCE_TENANT_CODE ?? "EVOLUXE").trim().toUpperCase();

const OWNER = {
  mobile: process.env.SHAZANA_OWNER_MOBILE?.trim() || "9700041413",
  password: process.env.SHAZANA_OWNER_PASSWORD?.trim() || "2026",
  name: process.env.SHAZANA_OWNER_NAME?.trim() || "Shazana Admin",
};

const GOLD_RATE_PAISE = Number(process.env.SHAZANA_GOLD_RATE_PAISE ?? 725_000);

async function wipeTransactionalData(tenantId) {
  const models = await import("../src/models/index.js");
  await models.LedgerEntry.collection.deleteMany({ tenantId });
  await models.AuditEvent.collection.deleteMany({ tenantId });
  await models.CashAdjustment.collection.deleteMany({ tenantId });

  const scoped = [
    models.Payment,
    models.PaymentIntent,
    models.PaymentLink,
    models.Scheme,
    models.Redemption,
    models.Customer,
    models.SchemePlan,
    models.GoldRate,
    models.Grievance,
    models.Message,
    models.CashHandover,
    models.OutboxEvent,
    models.ExportJob,
    models.Alert,
    models.Upload,
    models.IdempotencyRecord,
    models.Invoice,
    models.SubscriptionUpgradeRequest,
    models.EcommerceProduct,
    models.EcommerceCategory,
    models.EcommerceInventory,
    models.EcommerceBanner,
    models.EcommerceOrder,
    models.EcommerceSchemeReservation,
  ];
  for (const Model of scoped) {
    if (Model) await Model.deleteMany({ tenantId });
  }
  await User.deleteMany({ tenantId, type: UserType.TENANT_USER });
  await models.Counter.deleteMany({ _id: { $regex: `^${tenantId}:` } });
}

async function disableDemoInstance(tenant) {
  const instanceId = tenant.demoInstanceId;
  if (!instanceId) return null;
  await DemoInstance.updateOne(
    { _id: instanceId },
    {
      $set: {
        status: DemoInstanceStatus.DISABLED,
        disabledAt: new Date(),
        activeTenantId: null,
        activeGenerationId: null,
      },
      $inc: { version: 1 },
    },
  );
  const row = await DemoInstance.findById(instanceId).select("publicId status").lean();
  return row;
}

async function assertUniqueTenantMobile(mobileE164, tenantId) {
  const clash = await Tenant.findOne({ mobile: mobileE164, _id: { $ne: tenantId } }).select("code").lean();
  if (clash) {
    throw new Error(
      `Tenant mobile ${mobileE164} already used by ${clash.code}. Set SHAZANA_OWNER_MOBILE to a unique number.`,
    );
  }
}

async function ensureOwner(tenantId) {
  const ownerMobile10 = OWNER.mobile.replace(/\D/g, "").slice(-10);
  const existing = await User.findOne({
    tenantId,
    type: UserType.TENANT_USER,
    role: TenantRole.TENANT_OWNER,
    status: UserStatus.ACTIVE,
  });
  if (existing) {
    const passwordHash = await argon2.hash(OWNER.password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    await User.updateOne(
      { _id: existing._id },
      { $set: { name: OWNER.name, mobile: ownerMobile10, passwordHash, mustSetPassword: false } },
    );
    return { owner: existing, ownerMobile10 };
  }
  const passwordHash = await argon2.hash(OWNER.password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
  const owner = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId,
    branchId: null,
    role: TenantRole.TENANT_OWNER,
    name: OWNER.name,
    mobile: ownerMobile10,
    passwordHash,
    mustSetPassword: false,
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.TENANT_OWNER],
  });
  return { owner, ownerMobile10 };
}

async function promoteTenantToLive(tenant, ownerMobile10) {
  const mobileE164 = `+91${ownerMobile10}`;
  await assertUniqueTenantMobile(mobileE164, tenant._id);
  const growthPlan =
    (await SubscriptionPlan.findOne({ tier: PlanTier.GROWTH, active: true }).lean()) ??
    (await SubscriptionPlan.findById("splan_growth").lean());
  const planFeaturesSnapshot = {
    ...DEFAULT_PLAN_FEATURES[PlanTier.GROWTH],
    ecommerce: false,
    ecommercePayments: false,
    digitalMetals: false,
    customerSelfEnrol: true,
    flexibleScheme: true,
  };

  const displayName = (tenant.branding?.displayName ?? tenant.displayName ?? "Shazana Gold & Diamonds").replace(
    /\s*\(Demo\)\s*$/i,
    "",
  );
  const cleanName = (tenant.name ?? displayName).replace(/\s*\(Demo\)\s*$/i, "");

  await Tenant.updateOne(
    { _id: tenant._id },
    {
      $set: {
        name: cleanName,
        displayName,
        mobile: mobileE164,
        supportNumber: ownerMobile10,
        status: TenantStatus.ACTIVE,
        isDemo: false,
        goLiveAt: tenant.goLiveAt ?? new Date(),
        demoEntryCustomerId: null,
        demoEntrySchemeId: null,
        demoEntryPlanId: null,
        "branding.displayName": displayName,
        "operations.multiSchemePerCustomer": true,
        "operations.customerSelfEnrolEnabled": true,
        "operations.customerSelfRegistrationEnabled": true,
        "operations.customerAppWriteEnabled": true,
        "operations.customerAppPaymentsEnabled": true,
        "operations.ecommerceEnabled": false,
        "operations.ecommercePaymentsRolloutEnabled": false,
        "operations.digitalMetalsEnabled": false,
        "operations.receiptPrefix": tenant.operations?.receiptPrefix?.trim() || "SG",
        "operations.customerLoginMode": "OTP_ONLY",
        featureFlags: {
          customerAppEnabled: true,
          customerSelfEnrol: true,
          staffAppEnabled: true,
          onlinePayments: true,
          flexibleScheme: true,
          goldWeightScheme: false,
          passbookImageOnPayment: false,
        },
        "subscription.tier": PlanTier.GROWTH,
        "subscription.status": "ACTIVE",
        "subscription.planId": growthPlan?._id ?? "splan_growth",
        "subscription.billingCycle": BillingCycle.MONTHLY,
        "subscription.planFeaturesSnapshot": planFeaturesSnapshot,
      },
      $unset: { demoInstanceId: "" },
      $inc: { version: 1 },
    },
  );
}

async function main() {
  await connectDatabase();
  const code = (process.env.TENANT_CODE ?? DEFAULT_TENANT_CODE).trim().toUpperCase();
  const tenant = await Tenant.findOne({ code }).lean();
  if (!tenant) throw new Error(`Tenant ${code} not found.`);

  const branches = await Branch.find({ tenantId: tenant._id, active: true }).lean();
  if (!branches.length) {
    throw new Error(`${code} has no active branch — create MAIN before convert.`);
  }
  const hq = branches.find((b) => b.isHeadOffice) ?? branches[0];

  if (tenant.isDemo || process.env.FORCE_WIPE === "1") {
    console.log(`Wiping transactional data for ${code} (${tenant._id})…`);
    await wipeTransactionalData(tenant._id);
  } else {
    console.log("Tenant already live — skipping wipe (set FORCE_WIPE=1 to re-wipe).");
  }

  const disabledInstance = await disableDemoInstance(tenant);
  if (disabledInstance) {
    console.log(`Demo instance ${disabledInstance.publicId} → ${disabledInstance.status}`);
  }

  const { owner, ownerMobile10 } = await ensureOwner(tenant._id);
  await promoteTenantToLive(tenant, ownerMobile10);

  const rateToday = await GoldRate.findOne({
    tenantId: tenant._id,
    branchId: null,
    effectiveDate: today(),
    purity: "22K",
  }).lean();
  if (!rateToday) {
    await GoldRate.create({
      _id: createId("goldRate"),
      tenantId: tenant._id,
      branchId: null,
      ratePerGramPaise: GOLD_RATE_PAISE,
      effectiveDate: today(),
      purity: "22K",
      source: "MANUAL",
      enteredBy: owner._id,
    });
  }

  let flexPlan = await SchemePlan.findOne({
    tenantId: tenant._id,
    code: FLEX_CODE,
    status: SchemePlanStatus.ACTIVE,
  });
  if (!flexPlan) {
    const validated = validateCompletePlan(
      buildFlex65FixedCapCashPlan({
        code: FLEX_CODE,
        name: "Flex 6+5 Save",
        displayName: "6 months free · 5 months ₹5,000 cap",
      }),
    );
    flexPlan = await SchemePlan.create({
      _id: createId("plan"),
      tenantId: tenant._id,
      ...validated,
      createdBy: owner._id,
      version: 1,
    });
  }

  const { phonepe, messageCentral } = await copyTenantIntegrationSecrets({
    sourceCode: INTEGRATION_SOURCE,
    targetCode: code,
    preserveTargetEcommerce: true,
  });

  const visibleCount = await SchemePlan.countDocuments({
    tenantId: tenant._id,
    status: SchemePlanStatus.ACTIVE,
  });
  if (visibleCount !== 1 || flexPlan.code !== FLEX_CODE) {
    throw new Error(`Expected single active plan ${FLEX_CODE}, got ${visibleCount}.`);
  }

  console.log("\n=== Shazana → live jewellery ===\n");
  console.log(`Tenant:       ${code} (${tenant._id})`);
  console.log(`Branches:     ${branches.map((b) => b.code).join(", ")}`);
  console.log(`Portal:       ${ownerMobile10} / ${OWNER.password}`);
  console.log(`Scheme plan:  ${FLEX_CODE} only (Flex 6+5 cash)`);
  console.log(`Gold rate:    ₹${GOLD_RATE_PAISE / 100}/g (22K, tenant-wide)`);
  console.log(
    `Integrations: PhonePe ${phonepe?.environment ?? "—"} · OTP ${messageCentral?.customerId ? "Message Central" : "global .env"}`,
  );
  console.log(`Customer app: /customer/${code.toLowerCase()}/login`);
  console.log("\nNo demo customers or enrolments — self-enrol into FLEXI11 only.\n");
}

main()
  .then(() => disconnectDatabase())
  .catch(async (error) => {
    console.error(error.message ?? error);
    await disconnectDatabase().catch(() => {});
    process.exit(1);
  });