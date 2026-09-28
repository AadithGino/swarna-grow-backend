/**
 * Backfill tenant.usageCounters.activeCustomers from live ACTIVE customer counts.
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
