/**
 * Replace Shazana Gold demo flexible catalog (FLEXI11) with 6+5 fixed ₹5,000 cap cash plan.
 * Preserves existing enrolments on the old plan via legacy code rename.
 *
 *   npm run patch:shazana-flex-6-5
 *   TENANT_CODE=SHAZANAGOLDD node --env-file=.env scripts/patch-shazana-flex-6-5-plan.js
 */
import process from "node:process";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { SchemePlanStatus } from "../src/constants/enums.js";
import { mapCustomerPlanListItem } from "../src/lib/customer-app-dto.js";
import { createId } from "../src/lib/ids.js";
import { validateCompletePlan } from "../src/lib/plan-merge.js";
import { buildFlex65FixedCapCashPlan } from "./lib/flex-6-5-fixed-cap-plan.js";
import { seedShazanaFlexDemoShowcase } from "./lib/shazana-flex-demo-showcase.js";
import { Scheme, SchemePlan, Tenant } from "../src/models/index.js";

const DEFAULT_TENANT_CODE = "SHAZANAGOLDD";
const TARGET_CODE = "FLEXI11";
const LEGACY_PREFIX = "FLEXI11_LEGACY";

function rulesMatchFlex65(plan) {
  const flex = plan.flexibleRules ?? {};
  return (
    plan.paymentPattern === "FLEXIBLE"
    && plan.valueBasis === "CASH"
    && plan.durationMonths === 12
    && plan.installmentCount === 11
    && flex.flexiblePhaseCycles === 6
    && flex.cappedPhaseCycles === 5
    && flex.flexiblePhase?.minimumPaymentPaise === 10_000
    && flex.flexiblePhase?.minTotalPaise === 0
    && flex.capComputation?.minCycleCapPaise === 500_000
    && flex.capComputation?.maxCycleCapPaise === 500_000
    && plan.status === SchemePlanStatus.ACTIVE
  );
}

async function demoteOtherCustomerCatalogPlans(tenantId, keepPlanId) {
  const others = await SchemePlan.find({
    tenantId,
    _id: { $ne: keepPlanId },
    status: SchemePlanStatus.ACTIVE,
    "availability.visibleInCustomerApp": true,
  }).lean();
  if (!others.length) return;
  const bulk = others.map((row) =>
    SchemePlan.updateOne(
      { _id: row._id },
      {
        $set: {
          "availability.visibleInCustomerApp": false,
          "availability.customerSelfEnrolAllowed": false,
        },
        $inc: { version: 1 },
      },
    ),
  );
  await Promise.all(bulk);
  console.log(
    `Customer app: hid ${others.length} other active plan(s): ${others.map((p) => p.code).join(", ")}`,
  );
}

async function printCatalog(tenantId) {
  const activeVisible = await SchemePlan.find({
    tenantId,
    status: SchemePlanStatus.ACTIVE,
    "availability.visibleInCustomerApp": true,
  }).lean();
  console.log("\nCustomer catalog (active, visible):");
  for (const row of activeVisible.map(mapCustomerPlanListItem)) {
    console.log(`  · ${row.code} — ${row.paymentPatternLabel} — ${row.displayName}`);
  }
  if (!activeVisible.some((p) => p.code === TARGET_CODE)) {
    throw new Error(`${TARGET_CODE} missing from visible catalog.`);
  }
}

async function main() {
  await connectDatabase();
  const code = (process.env.TENANT_CODE ?? DEFAULT_TENANT_CODE).trim().toUpperCase();
  const tenant = await Tenant.findOne({ code }).lean();
  if (!tenant) throw new Error(`Tenant ${code} not found.`);

  let plan = await SchemePlan.findOne({
    tenantId: tenant._id,
    code: TARGET_CODE,
    status: SchemePlanStatus.ACTIVE,
  }).lean();

  if (plan && rulesMatchFlex65(plan)) {
    console.log(`${TARGET_CODE} already on 6+5 rules — refresh showcase + catalog.`);
  } else {
    const existing = await SchemePlan.findOne({ tenantId: tenant._id, code: TARGET_CODE }).lean();
    if (existing) {
      const enrolments = await Scheme.countDocuments({ tenantId: tenant._id, planId: existing._id });
      console.log(`Retiring ${TARGET_CODE} ${existing._id} (${enrolments} scheme(s) keep plan snapshots).`);
      const legacyCode = `${LEGACY_PREFIX}_${Date.now().toString(36).slice(-4).toUpperCase()}`;
      await SchemePlan.updateOne(
        { _id: existing._id },
        {
          $set: { code: legacyCode, status: SchemePlanStatus.INACTIVE },
          $inc: { version: 1 },
        },
      );
      console.log(`Renamed inactive plan → ${legacyCode}`);
    }

    const validated = validateCompletePlan(
      buildFlex65FixedCapCashPlan({
        code: TARGET_CODE,
        name: "Flex 6+5 Save",
        displayName: "6 months free · 5 months ₹5,000 cap",
      }),
    );

    const created = await SchemePlan.create({
      _id: createId("plan"),
      tenantId: tenant._id,
      ...validated,
      version: 1,
    });
    console.log(`Created ${TARGET_CODE} plan ${created._id}`);
    plan = created.toObject();
  }

  await demoteOtherCustomerCatalogPlans(tenant._id, plan._id);
  if (tenant.isDemo && process.env.SKIP_SHOWCASE !== "1") {
    await seedShazanaFlexDemoShowcase(tenant._id, plan._id);
  } else if (!tenant.isDemo) {
    console.log("Tenant is live (not demo) — skipping demo showcase seed.");
  }
  await printCatalog(tenant._id);
  console.log("\nShazana flex 6+5 rollout complete.");
}

main()
  .then(() => disconnectDatabase())
  .catch(async (error) => {
    console.error(error.message ?? error);
    await disconnectDatabase().catch(() => {});
    process.exit(1);
  });