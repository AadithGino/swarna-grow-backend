/**
 * Add 3 KAIRALI demo customers with in-progress schemes (2 × GOLD11, 1 × SAVING11).
 *
 *   npm run seed:kairali-scheme-samples
 */
import dayjs from "dayjs";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { CustomerStatus, TenantRole, UserStatus, UserType } from "../src/constants/enums.js";
import { addMonthsClamped, today } from "../src/lib/date.js";
import { createId } from "../src/lib/ids.js";
import { Branch, Customer, Scheme, SchemePlan, Tenant, User } from "../src/models/index.js";
import { nextSequence } from "../src/services/sequence.service.js";
import { createFixedScheme, payInstallments } from "./seed-aira-gold-matrix.js";

const TENANT_CODE = "KAIRALI";

const SAMPLES = [
  {
    name: "Rekha Gold Demo",
    mobile: "9847072001",
    planCode: "GOLD11",
    paidCount: 5,
    monthsAgoStart: 6,
    mode: "UPI",
  },
  {
    name: "Sunil Menon Gold",
    mobile: "9847072002",
    planCode: "GOLD11",
    paidCount: 3,
    monthsAgoStart: 4,
    mode: "CASH",
  },
  {
    name: "Anitha Rao Cash",
    mobile: "9847072003",
    planCode: "SAVING11",
    paidCount: 4,
    monthsAgoStart: 5,
    mode: "CARD",
  },
];

async function ensureCustomer(tenantId, branchId, { name, mobile }) {
  let customer = await Customer.findOne({ tenantId, mobile });
  if (customer) return customer;
  const seq = await nextSequence(tenantId, "customer");
  customer = await Customer.create({
    _id: createId("customer"),
    tenantId,
    branchId,
    customerNumber: `CUS-${String(seq).padStart(6, "0")}`,
    passbookNumber: `PB-SC-${mobile.slice(-4)}`,
    name,
    mobile,
    status: CustomerStatus.ACTIVE,
    kyc: { status: "VERIFIED", verifiedAt: dayjs().subtract(1, "month").toDate() },
    address: "MG Road, Mangalore, Karnataka",
  });
  return customer;
}

async function main() {
  await connectDatabase();

  const tenant = await Tenant.findOne({ code: TENANT_CODE });
  if (!tenant) throw new Error(`Run npm run seed:demo first — ${TENANT_CODE} missing`);

  const owner = await User.findOne({
    tenantId: tenant._id,
    role: TenantRole.TENANT_OWNER,
    status: UserStatus.ACTIVE,
  });
  if (!owner) throw new Error("Owner user missing");

  const branch = await Branch.findOne({ tenantId: tenant._id, code: "MGR", active: true });
  if (!branch) throw new Error("MGR branch missing");

  const plans = await SchemePlan.find({ tenantId: tenant._id, status: "ACTIVE" }).lean();
  const planByCode = Object.fromEntries(plans.map((p) => [p.code, p]));

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
    headers: { "user-agent": "seed-kairali-scheme-samples" },
    ip: "127.0.0.1",
    body: {},
    query: {},
  };

  const results = [];

  for (const sample of SAMPLES) {
    const planDoc = planByCode[sample.planCode];
    if (!planDoc) throw new Error(`Plan ${sample.planCode} not found on ${TENANT_CODE}`);
    const plan = await SchemePlan.findById(planDoc._id);

    const customer = await ensureCustomer(tenant._id, branch._id, sample);

    const existing = await Scheme.findOne({
      tenantId: tenant._id,
      customerId: customer._id,
      planId: plan._id,
      status: { $in: ["ACTIVE", "LOCKED", "MATURED"] },
    }).lean();

    if (existing) {
      results.push({
        name: customer.name,
        mobile: customer.mobile,
        plan: sample.planCode,
        enrollment: existing.enrollmentNumber,
        status: existing.status,
        note: "Already enrolled — skipped new scheme",
      });
      continue;
    }

    const startDate = addMonthsClamped(today(), -sample.monthsAgoStart).format("YYYY-MM-DD");
    const installmentAmountPaise = plan.amountRules?.fixedAmountPaise ?? 500_000;
    const scheme = await createFixedScheme(ctx, {
      customer,
      plan,
      branchId: branch._id,
      startDate,
      installmentAmountPaise,
    });
    await payInstallments(ctx, scheme, sample.paidCount, {
      mode: sample.mode,
      amountPaise: installmentAmountPaise,
      backdateFrom: startDate,
    });
    const updated = await Scheme.findById(scheme._id).lean();
    results.push({
      name: customer.name,
      mobile: customer.mobile,
      plan: sample.planCode,
      valueBasis: plan.valueBasis,
      enrollment: updated.enrollmentNumber,
      status: updated.status,
      installmentsPaid: sample.paidCount,
      installmentInr: installmentAmountPaise / 100,
    });
  }

  console.log(`\n=== ${TENANT_CODE} scheme sample customers ===\n`);
  console.log("Tenant login unchanged · owner 9847012345 / 2026\n");
  for (const row of results) {
    console.log(
      `· ${row.name} · ${row.mobile} · ${row.plan} (${row.valueBasis ?? "CASH"}) · ${row.enrollment} · ${row.installmentsPaid ?? "—"} paid · ${row.status}${row.note ? ` · ${row.note}` : ""}`,
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
