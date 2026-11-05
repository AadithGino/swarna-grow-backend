/**
 * KAIRALI webinar bulk demo — additive enrollments on top of `npm run seed:demo`.
 *
 * Default is FAST (~3–5 min): 2 highlight scenarios × 3 plans + extras.
 * Skips the heavy 12×3 matrix if webinar enrollments already exist.
 *
 * Flags:
 *   --extras-only   Finish tail only (today's collections, redemption queue, Kochi) ~2 min
 *   --full          Full 12×3 lifecycle matrix (~15 min) — use only when you need every edge case
 *   --force         Re-run matrix even if data exists
 *
 * Usage:
 *   npm run seed:demo   # once (~6 min)
 *   npm run seed:kairali-webinar-bulk
 */
import dayjs from "dayjs";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { CustomerStatus, TenantRole, UserStatus, UserType } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { Branch, Customer, Scheme, SchemePlan, Tenant, User } from "../src/models/index.js";
import { nextSequence } from "../src/services/sequence.service.js";
import { seedNobleJewelleryDemoMatrix } from "./seed-noble-jewellery-matrix.js";

const TENANT_CODE = "KAIRALI";
const EXTRA_COUNT = 14;
const HIGHLIGHTS_PER_PLAN = 2;
const PLAN_COUNT = 3;
const FULL_PER_PLAN = 12;

const WEBINAR_CUSTOMER_NAMES = [
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
  "Nandini Prasad",
  "Ouseph Mathew",
  "Pradeep Shenoy",
  "Radhika Namboothiri",
  "Shaji Varghese",
  "Thara Mohan",
  "Uday Shankar",
  "Vimala Krishnan",
  "Waseem Ahmed",
  "Zachariah Thomas",
  "Amrita Shenoy",
  "Basheer Ali",
];

function logStep(label) {
  console.log(`[kairali-webinar] ${label}…`);
}

function parseMode(argv) {
  if (argv.includes("--extras-only")) return "extras-only";
  if (argv.includes("--full")) return "full";
  return "highlights";
}

function customerPoolSize(mode) {
  if (mode === "extras-only") return EXTRA_COUNT;
  if (mode === "full") return FULL_PER_PLAN * PLAN_COUNT + EXTRA_COUNT;
  return HIGHLIGHTS_PER_PLAN * PLAN_COUNT + EXTRA_COUNT;
}

async function main() {
  const argv = process.argv.slice(2);
  let mode = parseMode(argv);
  const force = argv.includes("--force");

  await connectDatabase();

  const tenant = await Tenant.findOne({ code: TENANT_CODE });
  if (!tenant) {
    throw new Error(`Tenant ${TENANT_CODE} not found — run npm run seed:demo first`);
  }

  const owner = await User.findOne({
    tenantId: tenant._id,
    role: TenantRole.TENANT_OWNER,
    status: UserStatus.ACTIVE,
  });
  if (!owner) {
    throw new Error(`No active owner for ${TENANT_CODE}`);
  }

  const branchMgr = await Branch.findOne({ tenantId: tenant._id, code: "MGR", active: true });
  const branchKoc = await Branch.findOne({ tenantId: tenant._id, code: "KOC", active: true });
  if (!branchMgr || !branchKoc) {
    throw new Error("KAIRALI branches MGR / KOC not found");
  }

  const staffMain =
    (await User.findOne({
      tenantId: tenant._id,
      branchId: branchMgr._id,
      role: TenantRole.BRANCH_STAFF,
      status: UserStatus.ACTIVE,
    })) ?? owner;

  const plans = await SchemePlan.find({ tenantId: tenant._id, status: "ACTIVE" }).lean();
  const planByCode = Object.fromEntries(plans.map((p) => [p.code, p]));
  for (const code of ["SAVING11", "MICRO12", "SLAB11"]) {
    if (!planByCode[code]) {
      throw new Error(`Plan ${code} missing on ${TENANT_CODE} — run npm run seed:demo first`);
    }
  }

  const poolSize = customerPoolSize(mode);
  const names = WEBINAR_CUSTOMER_NAMES.slice(0, poolSize);

  logStep(`Ensuring ${names.length} webinar customers (mode=${mode})`);
  const demoCustomers = [];
  for (let n = 0; n < names.length; n += 1) {
    const mobile = `984706${String(n).padStart(4, "0")}`;
    const existing = await Customer.findOne({ tenantId: tenant._id, mobile });
    if (existing) {
      demoCustomers.push(existing);
      continue;
    }
    const seq = await nextSequence(tenant._id, "customer");
    const branchId = n >= poolSize - 2 ? branchKoc._id : branchMgr._id;
    demoCustomers.push(
      await Customer.create({
        _id: createId("customer"),
        tenantId: tenant._id,
        branchId,
        customerNumber: `CUS-${String(seq).padStart(6, "0")}`,
        passbookNumber: `PB-WB-${String(n + 1).padStart(4, "0")}`,
        name: names[n],
        mobile,
        status: CustomerStatus.ACTIVE,
        kyc: { status: "VERIFIED", verifiedAt: dayjs().subtract(2, "month").toDate() },
        address:
          n >= poolSize - 2
            ? "Marine Drive, Kochi, Kerala"
            : n % 2 === 0
              ? "MG Road, Mangalore, Karnataka"
              : "Kadri Hills, Mangalore, Karnataka",
      }),
    );
  }

  const webinarCustomerIds = demoCustomers.map((c) => c._id);
  const existingEnrollments = await Scheme.countDocuments({
    tenantId: tenant._id,
    customerId: { $in: webinarCustomerIds },
  });

  if (mode !== "extras-only" && !force && existingEnrollments >= 6) {
    console.log(
      `[kairali-webinar] ${existingEnrollments} webinar enrollments already present — skipping matrix. ` +
        "Use --force for full re-seed or --extras-only to add today's rows only.\n",
    );
    mode = "extras-only";
  }

  const ctx = {
    auth: {
      id: owner._id,
      tenantId: tenant._id,
      type: UserType.TENANT_USER,
      role: TenantRole.TENANT_OWNER,
    },
    scope: { tenantId: tenant._id },
    tenant,
    baseUrl: "/api/v1/admin",
    headers: { "user-agent": "seed-kairali-webinar-bulk" },
    ip: "127.0.0.1",
    body: {},
    query: {},
  };

  const staffCtx = {
    ...ctx,
    auth: {
      id: staffMain._id,
      tenantId: tenant._id,
      type: UserType.TENANT_USER,
      role: TenantRole.BRANCH_STAFF,
      branchId: branchMgr._id,
      name: staffMain.name,
    },
    scope: { tenantId: tenant._id, branchId: branchMgr._id },
  };

  const matrixMode =
    mode === "extras-only" ? "extras-only" : mode === "full" ? "full" : "highlights";

  console.log(`\nSeeding KAIRALI webinar bulk (matrixMode=${matrixMode})…\n`);

  const saving = await SchemePlan.findById(planByCode.SAVING11._id);
  const micro = await SchemePlan.findById(planByCode.MICRO12._id);
  const slab = await SchemePlan.findById(planByCode.SLAB11._id);

  const matrixSummary = await seedNobleJewelleryDemoMatrix(ctx, {
    swarna: saving,
    akshaya: micro,
    tritiya: slab,
    planLabels: ["SAVING11", "MICRO12", "SLAB11"],
    branchMain: branchMgr,
    branchKochi: branchKoc,
    customers: demoCustomers,
    staffCtx,
    staffLabel: staffMain.name,
    matrixMode,
  });

  console.log("\n=== KAIRALI webinar bulk ready ===\n");
  console.log(`Customers in pool: ${demoCustomers.length} · scenario rows: ${matrixSummary.length}\n`);

  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase();
  process.exit(1);
});
