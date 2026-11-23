/**
 * Copy PhonePe + Message Central (OTP) integration secrets from EVOLUXE → MYDREAM.
 *
 *   npm run patch:mydream-integrations-from-evoluxe
 *
 * Optional: SOURCE_TENANT_CODE=EVOLUXE TARGET_TENANT_CODE=MYDREAM
 */
import process from "node:process";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { copyTenantIntegrationSecrets } from "./lib/copy-tenant-integration-secrets.js";

const SOURCE = (process.env.SOURCE_TENANT_CODE ?? "EVOLUXE").trim().toUpperCase();
const TARGET = (process.env.TARGET_TENANT_CODE ?? "MYDREAM").trim().toUpperCase();

async function main() {
  await connectDatabase();

  const { targetId, phonepe, messageCentral } = await copyTenantIntegrationSecrets({
    sourceCode: SOURCE,
    targetCode: TARGET,
    preserveTargetEcommerce: true,
  });

  if (!messageCentral?.customerId) {
    console.warn(
      `Warning: ${SOURCE} has no Message Central bucket — OTP may use global mock/provider .env only.`,
    );
  }

  const slug = TARGET.toLowerCase();
  console.log(`\nCopied integration secrets ${SOURCE} → ${TARGET}.`);
  console.log(`  PhonePe: ${phonepe.environment ?? "—"} · ${phonepe.verificationStatus ?? "—"}`);
  if (messageCentral?.customerId) {
    console.log(`  Message Central: customer ${messageCentral.customerId} · ${messageCentral.verificationStatus ?? "—"}`);
  }
  console.log(`  Webhook: ${process.env.PUBLIC_BASE_URL ?? "http://localhost:4050"}/api/v1/webhooks/phonepe/${targetId}`);
  console.log(`\nCustomer portal: /customer/${slug}/login`);
  console.log("(Use same OTP_PROVIDER / PROVIDER_MODE as EVOLUXE in backend .env.)");
}

main()
  .then(() => disconnectDatabase())
  .catch(async (error) => {
    console.error(error.message ?? error);
    await disconnectDatabase().catch(() => {});
    process.exit(1);
  });