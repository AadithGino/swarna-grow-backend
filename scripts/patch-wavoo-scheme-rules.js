/**
 * Re-applies the WAVOO scheme rules (from scripts/seed-wavoo-jewellers.js) to the existing
 * WAVOOFLEXI and WAVOOSMART plans in the database, without wiping the tenant.
 *
 * Usage: node --env-file=.env scripts/patch-wavoo-scheme-rules.js
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Tenant, SchemePlan } from "../src/models/index.js";
import { flexiCashPlan, smartGoldPlan, WAVOO_TENANT_CODE } from "./seed-wavoo-jewellers.js";

const FIELDS = [
  "name",
  "displayName",
  "description",
  "valueBasis",
  "paymentPattern",
  "durationMonths",
  "installmentCount",
  "amountRules",
  "scheduleRules",
  "paymentRules",
  "redemptionRules",
  "benefit",
  "goldRules",
  "availability",
  "termsText",
  "status",
];

async function main() {
  await connectDatabase();

  const tenant = await Tenant.findOne({ code: WAVOO_TENANT_CODE }).lean();
  if (!tenant) throw new Error(`Tenant ${WAVOO_TENANT_CODE} not found. Run the seed first.`);

  for (const plan of [flexiCashPlan(), smartGoldPlan()]) {
    const $set = {};
    for (const key of FIELDS) if (plan[key] !== undefined) $set[key] = plan[key];

    const result = await SchemePlan.updateOne(
      { tenantId: tenant._id, code: plan.code },
      { $set },
    );
    console.log(`${plan.code}: matched=${result.matchedCount} modified=${result.modifiedCount}`);
  }

  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase();
  process.exit(1);
});
