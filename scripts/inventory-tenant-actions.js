/**
 * Read-only snapshot of KAIRALI records the tenant-portal action run needs.
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  Branch,
  CashHandover,
  Customer,
  GoldRate,
  Grievance,
  Redemption,
  Scheme,
  SchemePlan,
  Tenant,
  User,
} from "../src/models/index.js";

function slim(row, keys) {
  const out = { id: String(row._id) };
  for (const key of keys) out[key] = row[key];
  return out;
}

async function main() {
  await connectDatabase();
  const tenant = await Tenant.findOne({ code: "KAIRALI" }).lean();
  const scope = { tenantId: tenant._id };
  const plans = await SchemePlan.find(scope)
    .select("name code status valueBasis paymentPattern flexiblePhaseCycles cappedPhaseCycles displayName")
    .lean();
  const schemes = await Scheme.find({
    ...scope,
    status: { $in: ["ACTIVE", "LOCKED", "PENDING_PAYMENT", "MATURED", "DEFAULTED"] },
  })
    .select("enrollmentNumber status paymentPattern flexiblePhase valueBasis planId customerId branchId installments")
    .limit(40)
    .lean();
  const customers = await Customer.find(scope)
    .select("name mobile status kyc nominee branchId")
    .sort({ createdAt: -1 })
    .limit(8)
    .lean();
  const staff = await User.find({ ...scope, type: { $ne: "CUSTOMER" } })
    .select("name mobile role status active")
    .limit(12)
    .lean();
  const branches = await Branch.find(scope)
    .select("name code address mobile active status")
    .lean();
  const handovers = await CashHandover.find(scope)
    .select("status amountPaise agentId branchId")
    .sort({ createdAt: -1 })
    .limit(8)
    .lean();
  const tickets = await Grievance.find(scope)
    .select("subject status")
    .sort({ createdAt: -1 })
    .limit(6)
    .lean();
  const redemptions = await Redemption.find({
    ...scope,
    status: { $in: ["REQUESTED", "PENDING_APPROVAL", "APPROVED"] },
  })
    .select("status mode schemeId settlementPaise")
    .limit(8)
    .lean();
  const rates = await GoldRate.find(scope)
    .select("ratePerGramPaise effectiveDate branchId")
    .sort({ effectiveDate: -1, createdAt: -1 })
    .limit(3)
    .lean();
  const profile = {
    name: tenant.name,
    legalName: tenant.legalName,
    operations: tenant.operations,
    branding: tenant.branding,
    subscription: tenant.subscription,
  };
  console.log(
    JSON.stringify(
      {
        plans: plans.map((p) =>
          slim(p, ["name", "code", "status", "valueBasis", "paymentPattern", "flexiblePhaseCycles", "cappedPhaseCycles", "displayName"]),
        ),
        schemes: schemes.map((s) => ({
          id: String(s._id),
          schemeNo: s.enrollmentNumber,
          status: s.status,
          paymentPattern: s.paymentPattern,
          flexiblePhase: s.flexiblePhase,
          valueBasis: s.valueBasis,
          customerId: s.customerId,
          paid: (s.installments ?? []).filter((i) => i.status === "PAID").length,
          total: (s.installments ?? []).length,
          nextDue: (s.installments ?? []).find((i) => i.status !== "PAID")?.dueDate,
        })),
        customers: customers.map((c) =>
          slim(c, ["name", "mobile", "status", "kyc", "nominee", "branchId"]),
        ),
        staff: staff.map((u) => slim(u, ["name", "mobile", "role", "status", "active"])),
        branches: branches.map((b) => ({
          id: String(b._id),
          name: b.name,
          code: b.code,
          active: b.active,
          status: b.status,
          address: b.address ?? null,
        })),
        handovers: handovers.map((h) => slim(h, ["status", "amountPaise"])),
        tickets: tickets.map((t) => slim(t, ["subject", "status"])),
        redemptions: redemptions.map((r) => slim(r, ["status", "mode", "schemeId", "settlementPaise"])),
        rates,
        profileKeys: {
          name: profile.name,
          legalName: profile.legalName,
          operationKeys: profile.operations ? Object.keys(profile.operations) : [],
          brandingKeys: profile.branding ? Object.keys(profile.branding) : [],
          subscriptionStatus: profile.subscription?.status ?? profile.subscription?.planCode ?? null,
        },
      },
      null,
      2,
    ),
  );
  await disconnectDatabase();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
