#!/usr/bin/env node
/**
 * Phase 1 of the Tenant.mobile rollout for Demo Builder (plan section 4.1, 15, 16).
 *
 * A demo tenant must never collide with the existing `mobile_1` unique index (it has no real
 * mobile), and must never get assigned the real source tenant's mobile. The target end-state
 * is a partial unique index — mobile_1_live_only — that only applies when isDemo: false
 * (already declared on tenantSchema in src/models/identity.models.js, but NOT yet applied to
 * the live database; only scripts/sync-indexes.js does that).
 *
 * This script is step 1, and only step 1: backfill isDemo: false on every existing Tenant/
 * Customer document that doesn't have the field yet, and report (never silently skip) any
 * tenant with a missing/invalid mobile so an operator can look at it before the new index is
 * relied on. It does NOT create or drop any index — that is scripts/sync-indexes.js's job,
 * run separately, after this backfill is verified clean.
 *
 * Usage:
 *   node --env-file=.env scripts/migrate-tenant-demo-mobile-index-dry-run.mjs            # report only
 *   node --env-file=.env scripts/migrate-tenant-demo-mobile-index-dry-run.mjs --apply    # backfill isDemo:false
 *
 * Full rollout sequence (do not skip steps or reorder them):
 *   1. Run this script with --apply to backfill isDemo: false on Tenant and Customer.
 *   2. Review this script's "tenants missing a usable mobile" report. Every live tenant must
 *      have a non-empty string mobile before step 3, or mobile_1_live_only will be violated
 *      by real data the moment it is created.
 *   3. node scripts/sync-indexes.js --dry-run   (confirm it only proposes CREATING
 *      mobile_1_live_only, not dropping mobile_1 yet)
 *   4. node scripts/sync-indexes.js --apply
 *   5. Only once (3)-(4) are live in every environment and you've confirmed no code path
 *      still depends on the unconditional mobile_1 index: drop it explicitly with
 *      node scripts/sync-indexes.js --apply-drops --operator-confirm-drops --confirm-drop mobile_1
 *      and then remove the old `tenantSchema.index({ mobile: 1 }, { name: "mobile_1", ... })`
 *      line from src/models/identity.models.js in the same change.
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Customer, Tenant } from "../src/models/index.js";

const apply = process.argv.includes("--apply");

async function backfillIsDemoFalse(Model, label) {
  const missingCount = await Model.countDocuments({ isDemo: { $exists: false } });
  if (!apply) {
    return { label, missingIsDemoField: missingCount, modified: 0, dryRun: true };
  }
  const result = await Model.updateMany(
    { isDemo: { $exists: false } },
    { $set: { isDemo: false } },
  );
  return {
    label,
    missingIsDemoField: missingCount,
    modified: result.modifiedCount,
    dryRun: false,
  };
}

async function reportTenantsMissingUsableMobile() {
  const offending = await Tenant.find({
    $or: [{ mobile: { $exists: false } }, { mobile: null }, { mobile: "" }],
  })
    .select("_id code name isDemo")
    .lean();
  return offending.map((t) => ({ _id: t._id, code: t.code, name: t.name, isDemo: t.isDemo ?? null }));
}

async function reportDuplicateLiveMobiles() {
  // Simulates what mobile_1_live_only would reject: duplicate mobile values among
  // isDemo:false tenants. Run this after the backfill, before creating the index.
  const duplicates = await Tenant.aggregate([
    { $match: { isDemo: false, mobile: { $type: "string" } } },
    { $group: { _id: "$mobile", tenantIds: { $push: "$_id" }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  return duplicates;
}

await connectDatabase();
try {
  const tenantBackfill = await backfillIsDemoFalse(Tenant, "Tenant");
  const customerBackfill = await backfillIsDemoFalse(Customer, "Customer");
  const tenantsMissingMobile = await reportTenantsMissingUsableMobile();
  const duplicateLiveMobiles = apply ? await reportDuplicateLiveMobiles() : [];

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run (pass --apply to backfill isDemo:false)",
        backfill: [tenantBackfill, customerBackfill],
        tenantsMissingUsableMobile: tenantsMissingMobile,
        tenantsMissingUsableMobileCount: tenantsMissingMobile.length,
        duplicateLiveMobiles,
        blocksIndexRollout:
          tenantsMissingMobile.length > 0 || duplicateLiveMobiles.length > 0
            ? "YES — resolve the tenants/duplicates listed above before running sync-indexes.js"
            : "no known blockers from this check",
      },
      null,
      2,
    ),
  );
} finally {
  await disconnectDatabase();
}
