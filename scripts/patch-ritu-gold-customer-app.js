/**
 * Enable customer app for existing RITUGOLD tenant (no full re-seed).
 *
 * Local:  npm run patch:ritu-gold-customer-app
 * Prod (same DB as Vercel API): MONGODB_URI='…' node scripts/patch-ritu-gold-customer-app.js
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { normalizeFeatureFlags } from "../src/constants/platform-feature-flags.js";
import { isPlatformFlagEnabled } from "../src/lib/feature-entitlements.js";
import { SchemePlan, Tenant } from "../src/models/index.js";

async function main() {
  await connectDatabase();
  const tenant = await Tenant.findOne({ code: "RITUGOLD" });
  if (!tenant) {
    console.error("Tenant RITUGOLD not found. Run npm run seed:ritu-gold first.");
    process.exitCode = 1;
    return;
  }

  const featureFlags = normalizeFeatureFlags(tenant.featureFlags);
  featureFlags.customerAppEnabled = true;
  featureFlags.customerSelfEnrol = true;
  featureFlags.onlinePayments = true;

  await Tenant.findByIdAndUpdate(tenant._id, {
    $set: {
      featureFlags,
      "settings.customerAppMaintenance": false,
      "operations.customerSelfEnrolEnabled": true,
      "operations.customerSelfRegistrationEnabled": true,
      "operations.customerAppWriteEnabled": true,
      "operations.customerAppPaymentsEnabled": true,
    },
  });

  const planResult = await SchemePlan.updateMany(
    { tenantId: tenant._id },
    {
      $set: {
        "availability.visibleInCustomerApp": true,
        "availability.customerSelfEnrolAllowed": true,
      },
    },
  );

  const verify = await Tenant.findOne({ code: "RITUGOLD" });
  const ok = isPlatformFlagEnabled(verify, "customerAppEnabled");
  console.log("RITUGOLD customer app enabled.");
  console.log(`  Plans updated: ${planResult.modifiedCount}`);
  console.log(`  customerAppEnabled effective: ${ok}`);
  if (!ok) {
    console.error("  ERROR: flag still off after patch — check Mongo featureFlags document.");
    process.exitCode = 1;
  }
  console.log("  Customer login: OTP with mobiles 9847654401–9847654422 (see RITU_GOLD_DEMO.md)");
  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase();
  process.exitCode = 1;
});
