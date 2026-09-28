/**
 * One-time / maintenance backfill: set tenant.usageCounters.activeCustomers from
 * live ACTIVE customer counts.
 *
 * When to run: after deploying transactional capacity counters, before enabling
 * strict limits in production, or if ops suspects counter drift. Not required on
 * every deploy when application paths already maintain usageCounters.
 *
 * Verify parity (read-only):
 *   db.customers.aggregate([{ $match: { status: "ACTIVE" } }, { $group: { _id: "$tenantId", n: { $sum: 1 } } }])
 *   compare to tenants.usageCounters.activeCustomers per tenant.
 *
 * Race safety: run during a maintenance window or low traffic. This script uses
 * unconditional $set and can overwrite a concurrent $inc from live signups;
 * application create/block paths use MongoDB transactions and must remain the
 * source of truth during normal operation.
 *
 * Run: node --env-file=.env scripts/seed-active-customer-counters.js
 */
import mongoose from "mongoose";
import { Customer, Tenant } from "../src/models/index.js";
import { CustomerStatus } from "../src/constants/enums.js";
import { env } from "../src/config/env.js";

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const tenants = await Tenant.find({}).select("_id code usageCounters").lean();
  let updated = 0;
  for (const tenant of tenants) {
    const used = await Customer.countDocuments({
      tenantId: tenant._id,
      status: CustomerStatus.ACTIVE,
    });
    const current = tenant.usageCounters?.activeCustomers;
    if (current === used) continue;
    await Tenant.updateOne(
      { _id: tenant._id },
      {
        $set: {
          usageCounters: {
            activeCustomers: used,
            activeCustomersSeededAt: new Date(),
          },
        },
      },
    );
    updated += 1;
    console.log(`${tenant.code ?? tenant._id}: activeCustomers=${used}`);
  }
  console.log(`Done. Updated ${updated} of ${tenants.length} tenants.`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
