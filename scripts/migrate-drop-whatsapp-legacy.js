/**
 * One-off cleanup after WhatsApp removal: unset legacy tenant/customer fields.
 * Safe to re-run (idempotent).
 *
 * Usage: node scripts/migrate-drop-whatsapp-legacy.js
 */
import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import { Customer, Tenant, TemplateDefinition } from "../src/models/index.js";

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const tenantResult = await Tenant.updateMany(
    {},
    {
      $unset: {
        "integrationSecrets.whatsapp": "",
      },
    },
  );
  const customerResult = await Customer.updateMany(
    { whatsappOptedOutAt: { $exists: true } },
    { $unset: { whatsappOptedOutAt: "" } },
  );
  const templateResult = await TemplateDefinition.deleteMany({});
  console.log(JSON.stringify({
    tenantsModified: tenantResult.modifiedCount,
    customersModified: customerResult.modifiedCount,
    templateDefinitionsRemoved: templateResult.deletedCount,
  }, null, 2));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
