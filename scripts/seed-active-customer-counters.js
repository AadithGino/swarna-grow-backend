/**
 * Backfill tenant.usageCounters.activeCustomers from live ACTIVE customer counts.
 *
 * Preview (no writes):
 *   node --env-file=.env scripts/seed-active-customer-counters.js --dry-run
 *
 * Apply (requires operator acknowledgement; one short transaction per tenant):
 *   REQUIRE_MAINTENANCE_ACK=1 node --env-file=.env scripts/seed-active-customer-counters.js
 *
 * ACK gates apply mode only. It does not pause live traffic — safety comes from per-tenant
 * MongoDB transactions that conflict with customer create/block/unblock seat updates on the
 * same tenant document. Transient write conflicts retry the full count-and-update; persistent
 * failures are reported per tenant and the process exits nonzero. A partial apply is safe to
 * rerun: unchanged tenants are skipped after parity check; failed tenants are retried.
 *
 * Verify parity manually:
 *   db.customers.aggregate([{ $match: { status: "ACTIVE" } }, { $group: { _id: "$tenantId", n: { $sum: 1 } } }])
 *   compare to tenants.usageCounters.activeCustomers.
 */
import mongoose from "mongoose";
import { Tenant } from "../src/models/index.js";
import { env } from "../src/config/env.js";
import {
  parityForTenant,
  syncActiveCustomerCounterForTenant,
  verifyAllTenantsInSync,
} from "../src/lib/active-customer-counter-sync.js";

const dryRun = process.argv.includes("--dry-run");

function printParityTable(rows) {
  console.log("tenantId\tcode\tstored\tactual\tdelta");
  let drift = 0;
  for (const row of rows) {
    if (!row.inSync) drift += 1;
    console.log(
      `${row.tenantId}\t${row.code}\t${row.stored ?? "—"}\t${row.actual}\t${row.delta}`,
    );
  }
  const totals = rows.reduce(
    (acc, row) => {
      acc.actual += row.actual;
      if (typeof row.stored === "number") acc.stored += row.stored;
      return acc;
    },
    { stored: 0, actual: 0 },
  );
  console.log(
    `Totals: stored=${totals.stored} actual=${totals.actual} tenants=${rows.length} drift=${drift}`,
  );
  return drift;
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const tenants = await Tenant.find({}).select("_id code usageCounters").lean();
  const parityRows = [];
  for (const tenant of tenants) {
    parityRows.push(await parityForTenant(tenant));
  }

  if (dryRun) {
    console.log("DRY RUN — no database writes.");
    const drift = printParityTable(parityRows);
    await mongoose.disconnect();
    process.exit(drift > 0 ? 0 : 0);
  }

  if (process.env.REQUIRE_MAINTENANCE_ACK !== "1") {
    console.error(
      "Refusing apply: set REQUIRE_MAINTENANCE_ACK=1 after reviewing --dry-run output.",
    );
    console.error(
      "This updates only usageCounters.activeCustomers and activeCustomersSeededAt per tenant.",
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  let changed = 0;
  let unchanged = 0;
  const failed = [];

  for (const row of parityRows) {
    if (row.inSync) {
      unchanged += 1;
      continue;
    }
    try {
      const actual = await syncActiveCustomerCounterForTenant(row.tenantId);
      if (actual === row.actual) changed += 1;
      else {
        failed.push({ ...row, error: `post-sync count mismatch (got ${actual})` });
      }
      console.log(`${row.code}: activeCustomers=${actual} (was ${row.stored ?? "—"})`);
    } catch (error) {
      failed.push({ ...row, error: error?.message ?? String(error) });
      console.error(`${row.code}: FAILED — ${error?.message ?? error}`);
    }
  }

  const stillDrift = await verifyAllTenantsInSync();
  console.log(
    `Done. changed=${changed} unchanged=${unchanged} failed=${failed.length} remainingDrift=${stillDrift.length}`,
  );

  await mongoose.disconnect();
  if (failed.length || stillDrift.length) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
