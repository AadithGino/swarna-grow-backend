/**
 * Noble Jewellery — client demo tenant (fixed gold schemes only, STARTER tier).
 *
 * · 48 customers with full lifecycle matrix per Swarna / Akshaya / Tritiya
 * · Today's collections, matured / redeemable / redemption queue / redeemed samples
 * · Main + Kochi branches, historical gold rates, staff logins
 *
 * Usage: npm run seed:noble-jewellery
 * Login: tenant NOBLE · mobile 9847020100 · password 2026
 */
import argon2 from "argon2";
import dayjs from "dayjs";
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
import { addMonthsClamped, today } from "../src/lib/date.js";
import { createId } from "../src/lib/ids.js";
import {
  buildCollectionGoldPlan,
  STANDARD_COLLECTION_PLAN_DEFS,
} from "./lib/collection-gold-plan-seed.js";
import { seedNobleJewelleryDemoMatrix } from "./seed-noble-jewellery-matrix.js";
import {
  Branch,
  Customer,
  GoldRate,
  LedgerEntry,
  Payment,
  PaymentIntent,
  PaymentLink,
  Redemption,
  Scheme,
  SchemePlan,
  SubscriptionPlan,
  Tenant,
  User,
  Counter,
  CashHandover,
} from "../src/models/index.js";
import { nextSequence } from "../src/services/sequence.service.js";

const DEMO = {
  tenantCode: "NOBLE",
  tenantName: "Noble Jewellery",
  displayName: "Noble Jewellery",
  city: "Thrissur",
  ownerName: "Rajesh Noble",
  ownerMobile: process.env.NOBLE_OWNER_MOBILE?.trim() || "9847020100",
  ownerPassword: process.env.NOBLE_OWNER_PASSWORD?.trim() || "2026",
  goldRatePerGramPaise: 715_000,
};

const CUSTOMER_NAMES = [
  "Aaradhya Nair",
  "Balachandran Menon",
  "Chitra Varma",
  "Deepak Krishnan",
  "Esha Pillai",
  "Farhan Ali",
  "Gayathri Suresh",
  "Harikrishnan Iyer",
  "Indu Mohan",
  "Jyothi Das",
  "Kiran Babu",
  "Lakshmi Raj",
  "Manoj Thomas",
  "Neethu Varghese",
  "Oommen Chacko",
  "Parvathy Unni",
  "Qadir Hussain",
  "Reshma Nambiar",
  "Sandeep Kurup",
  "Teena Joseph",
  "Unnikrishnan P",
  "Vidya Menon",
  "Wilson George",
  "Xavier Puthussery",
  "Yamuna Devi",
  "Zainab Rahman",
  "Anjali Krishnan",
  "Biju Narayanan",
  "Celina Mathew",
  "Dinesh Kumar",
  "Fathima Beevi",
  "Gopalakrishnan N",
  "Hema Lakshmi",
  "Irfan Malik",
  "Jessy Paul",
  "Krishnakumar S",
  "Leela Ramachandran",
  "Murali Gopalan",
  "Nisha Prasad",
  "Pradeep Nair",
  "Rahul Varma",
  "Shalini Menon",
  "Tomy Sebastian",
  "Usha Krishnan",
  "Vineeth Raj",
  "Wafa Siddique",
  "Yadu Krishnan",
  "Zachariah Thomas",
  "Amal Dev",
  "Beena Rajan",
];

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
    GoldRate,
    CashHandover,
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

  const starterPlan =
    (await SubscriptionPlan.findOne({ tier: PlanTier.STARTER, active: true }).lean()) ??
    (await SubscriptionPlan.findById("splan_starter").lean());
  const planFeaturesSnapshot = {
    ...DEFAULT_PLAN_FEATURES[PlanTier.STARTER],
    multiBranch: true,
    flexibleScheme: false,
    goldWeightScheme: true,
    customerSelfEnrol: false,
    ecommerce: false,
    ecommercePayments: false,
    digitalMetals: false,
  };

  const tenantId = createId("tenant");
  const branchMainId = createId("branch");
  const branchKochiId = createId("branch");
  const ownerId = createId("user");
  const managerId = createId("user");
  const staffMainId = createId("user");
  const staffKochiId = createId("user");

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
    goLiveAt: dayjs().subtract(8, "month").toDate(),
    address: { line1: "MG Road", city: DEMO.city, state: "Kerala", pincode: "680001" },
    branding: {
      displayName: DEMO.displayName,
      primaryColor: "#1B3A4B",
      accentColor: "#C9A227",
    },
    settings: {
      requireKycForEnrolment: false,
      oneActiveSchemePerCustomer: false,
      customerAppMaintenance: false,
    },
    operations: {
      multiSchemePerCustomer: true,
      receiptPrefix: "NB",
      customerSelfEnrolEnabled: false,
      customerSelfRegistrationEnabled: false,
      customerAppWriteEnabled: false,
      customerAppPaymentsEnabled: false,
      ecommerceEnabled: false,
      digitalMetalsEnabled: false,
      termsAndConditions: "Noble Jewellery gold savings scheme terms and conditions.",
    },
    featureFlags: {
      customerAppEnabled: false,
      customerSelfEnrol: false,
      staffAppEnabled: true,
      onlinePayments: true,
      flexibleScheme: false,
      goldWeightScheme: true,
    },
    subscription: {
      tier: PlanTier.STARTER,
      status: "ACTIVE",
      planId: starterPlan?._id ?? "splan_starter",
      billingCycle: BillingCycle.MONTHLY,
      startsAt: dayjs().subtract(8, "month").toDate(),
      renewsAt: new Date(Date.now() + 365 * 86_400_000),
      limits: {
        ...(starterPlan?.limits ?? {}),
        activeCustomers: 500,
        branches: 2,
        staff: 8,
        schemePlans: 5,
        whatsappMessages: 2000,
      },
      planFeaturesSnapshot,
      featureOverrides: { multiBranch: true },
    },
  });

  const branchMain = await Branch.create({
    _id: branchMainId,
    tenantId,
    code: "MAIN",
    name: "Noble Jewellery — Thrissur Main",
    address: { line1: "MG Road", city: DEMO.city, state: "Kerala", pincode: "680001" },
    isHeadOffice: true,
    active: true,
  });

  const branchKochi = await Branch.create({
    _id: branchKochiId,
    tenantId,
    code: "KOC",
    name: "Noble Jewellery — Kochi",
    address: { line1: "Marine Drive", city: "Kochi", state: "Kerala", pincode: "682011" },
    isHeadOffice: false,
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

  const manager = await User.create({
    _id: managerId,
    type: UserType.TENANT_USER,
    tenantId,
    branchId: branchMain._id,
    role: TenantRole.BRANCH_MANAGER,
    name: "Anu Noble",
    mobile: "9847020101",
    passwordHash,
    mustSetPassword: false,
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_MANAGER],
  });

  const staffMain = await User.create({
    _id: staffMainId,
    type: UserType.TENANT_USER,
    tenantId,
    branchId: branchMain._id,
    role: TenantRole.BRANCH_STAFF,
    name: "Priya Noble",
    mobile: "9847020102",
    passwordHash,
    mustSetPassword: false,
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_STAFF],
  });

  await User.create({
    _id: staffKochiId,
    type: UserType.TENANT_USER,
    tenantId,
    branchId: branchKochi._id,
    role: TenantRole.BRANCH_STAFF,
    name: "Sanjay K",
    mobile: "9847020103",
    passwordHash,
    mustSetPassword: false,
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_STAFF],
  });

  const rateDates = new Set();
  for (let m = 14; m >= 0; m -= 1) {
    rateDates.add(addMonthsClamped(today(), -m).startOf("month").format("YYYY-MM-DD"));
  }
  rateDates.add(today());
  const sortedRateDates = [...rateDates].sort();
  for (let i = 0; i < sortedRateDates.length; i += 1) {
    const effectiveDate = sortedRateDates[i];
    const drift = Math.round(i * 180);
    await GoldRate.create({
      _id: createId("goldRate"),
      tenantId,
      branchId: null,
      ratePerGramPaise: DEMO.goldRatePerGramPaise + drift,
      effectiveDate,
      purity: "22K",
      source: "MANUAL",
      enteredBy: owner._id,
    });
  }

  const plans = [];
  for (const def of STANDARD_COLLECTION_PLAN_DEFS) {
    const planBody = buildCollectionGoldPlan(def);
    const lockIn = def.lockInMonths ?? planBody.durationMonths;
    plans.push(
      await SchemePlan.create({
        _id: createId("plan"),
        tenantId,
        ...planBody,
        paymentRules: {
          ...planBody.paymentRules,
          maxAdvanceInstallments: Math.max(lockIn - 1, planBody.paymentRules.maxAdvanceInstallments ?? 0),
        },
        createdBy: owner._id,
        version: 1,
      }),
    );
  }
  const planByCode = Object.fromEntries(plans.map((p) => [p.code, p]));

  const demoCustomers = [];
  for (let n = 0; n < CUSTOMER_NAMES.length; n += 1) {
    const seq = await nextSequence(tenantId, "customer");
        const branchId = n >= 46 ? branchKochi._id : branchMain._id;
    demoCustomers.push(
      await Customer.create({
        _id: createId("customer"),
        tenantId,
        branchId,
        customerNumber: `CUS-${String(seq).padStart(6, "0")}`,
        passbookNumber: `PB-${String(seq).padStart(6, "0")}`,
        name: CUSTOMER_NAMES[n],
        mobile: `9847031${String(n).padStart(3, "0")}`,
        status: CustomerStatus.ACTIVE,
        kyc: { status: "VERIFIED", verifiedAt: dayjs().subtract(3, "month").toDate() },
        address:
          n >= 44
            ? "Marine Drive, Kochi, Kerala"
            : n % 2 === 0
              ? "Near Swaraj Round, Thrissur, Kerala"
              : "Poothole Lane, Thrissur, Kerala",
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
    headers: { "user-agent": "seed-noble-jewellery" },
    ip: "127.0.0.1",
    body: {},
    query: {},
  };

  const staffCtx = {
    ...ctx,
    auth: {
      id: staffMain._id,
      tenantId,
      type: UserType.TENANT_USER,
      role: TenantRole.BRANCH_STAFF,
      branchId: branchMain._id,
      name: staffMain.name,
    },
    scope: { tenantId, branchId: branchMain._id },
  };

  console.log("\nSeeding Noble Jewellery demo data (target ~2 min)…\n");
  const matrixSummary = await seedNobleJewelleryDemoMatrix(ctx, {
    swarna: planByCode.SWARNA,
    akshaya: planByCode.AKSHAYA,
    tritiya: planByCode.TRITIYA,
    branchMain,
    branchKochi,
    customers: demoCustomers,
    staffCtx,
    staffLabel: staffMain.name,
  });

  console.log("\n=== Noble Jewellery tenant ready ===\n");
  console.log(`Tenant code:     ${DEMO.tenantCode}`);
  console.log(`Display name:    ${DEMO.displayName}`);
  console.log(`Branches:        ${branchMain.name}; ${branchKochi.name}`);
  console.log(
    `Portal login:    tenant ${DEMO.tenantCode} · owner ${owner.mobile} · password ${DEMO.ownerPassword}`,
  );
  console.log(`Staff (same PIN): manager ${manager.mobile}, staff ${staffMain.mobile}, Kochi 9847020103`);
  console.log(`Subscription:    STARTER — fixed gold schemes only (no flex / ecommerce / digital metals)`);
  console.log(
    `Gold rate today: ₹${(DEMO.goldRatePerGramPaise / 100).toLocaleString("en-IN")}/g 22K (+ historical rates)\n`,
  );
  console.log("Scheme plans:");
  for (const p of plans) {
    console.log(
      `  · ${p.code} — ${p.displayName ?? p.name} (${p.durationMonths}m) — ${p.benefit?.bonusValue}% maturity bonus`,
    );
  }
  console.log(`\nCustomers: ${demoCustomers.length} · enrollments / scenarios: ${matrixSummary.length}\n`);
  console.log("Scenario map (search customer name in portal):\n");
  for (const row of matrixSummary) {
    const enr = row.enrollment ? ` ${row.enrollment}` : "";
    console.log(`  · ${row.customer}${enr} — ${row.story}`);
  }
  console.log("");

  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase();
  process.exit(1);
});
