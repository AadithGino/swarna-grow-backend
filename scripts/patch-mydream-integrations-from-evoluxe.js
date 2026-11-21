/**
 * Copy PhonePe + Message Central (OTP) integration secrets from EVOLUXE → MYDREAM.
 *
 *   npm run patch:mydream-integrations-from-evoluxe
 *
 * Optional: SOURCE_TENANT_CODE=EVOLUXE TARGET_TENANT_CODE=MYDREAM
 */
import process from "node:process";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { invalidatePhonePeClientCache } from "../src/integrations/phonepe.provider.js";
import { invalidateMessageCentralAuthCache } from "../src/lib/message-central-credentials.js";
import { Tenant } from "../src/models/index.js";

const SOURCE = (process.env.SOURCE_TENANT_CODE ?? "EVOLUXE").trim().toUpperCase();
const TARGET = (process.env.TARGET_TENANT_CODE ?? "MYDREAM").trim().toUpperCase();

function cloneSubdoc(value) {
  if (!value || typeof value !== "object") return undefined;
  return JSON.parse(JSON.stringify(value));
}

async function main() {
  await connectDatabase();

  const source = await Tenant.findOne({ code: SOURCE }).select("+integrationSecrets");
  if (!source) throw new Error(`Source tenant ${SOURCE} not found.`);

  const target = await Tenant.findOne({ code: TARGET }).select("+integrationSecrets");
  if (!target) throw new Error(`Target tenant ${TARGET} not found. Run seed:my-dream-diamond first.`);

  const srcSecrets = source.integrationSecrets ?? {};
  const phonepe = cloneSubdoc(srcSecrets.phonepe);
  const messageCentral = cloneSubdoc(srcSecrets.messageCentral);

  if (!phonepe?.clientId) {
    throw new Error(
      `${SOURCE} has no PhonePe credentials. Run npm run configure:evoluxe-phonepe first.`,
    );
  }

  target.integrationSecrets ??= {};
  target.integrationSecrets.phonepe = phonepe;
  if (messageCentral?.customerId) {
    target.integrationSecrets.messageCentral = messageCentral;
  } else {
    console.warn(
      `Warning: ${SOURCE} has no Message Central bucket — OTP may use global mock/provider .env only.`,
    );
  }

  target.operations ??= {};
  target.operations.customerAppPaymentsEnabled = source.operations?.customerAppPaymentsEnabled ?? true;
  target.operations.customerAppWriteEnabled = source.operations?.customerAppWriteEnabled ?? true;
  target.operations.ecommerceEnabled = target.operations.ecommerceEnabled ?? true;
  target.operations.ecommercePaymentsRolloutEnabled =
    source.operations?.ecommercePaymentsRolloutEnabled ?? true;

  if (!target.branding?.websiteUrl && source.branding?.websiteUrl) {
    target.branding ??= {};
    target.branding.websiteUrl = source.branding.websiteUrl;
  }

  target.markModified("integrationSecrets");
  target.markModified("operations");
  if (target.branding) target.markModified("branding");
  target.version = Number(target.version ?? 0) + 1;
  await target.save();

  invalidatePhonePeClientCache(target._id);
  if (messageCentral?.customerId) {
    invalidateMessageCentralAuthCache(target._id);
  }

  console.log(`\nCopied integration secrets ${SOURCE} → ${TARGET}.`);
  console.log(`  PhonePe: ${phonepe.environment ?? "—"} · ${phonepe.verificationStatus ?? "—"}`);
  if (messageCentral?.customerId) {
    console.log(`  Message Central: customer ${messageCentral.customerId} · ${messageCentral.verificationStatus ?? "—"}`);
  }
  console.log(`  Webhook: ${process.env.PUBLIC_BASE_URL ?? "http://localhost:4050"}/api/v1/webhooks/phonepe/${target._id}`);
  console.log(`\nCustomer portal: /customer/mydream/login`);
  console.log("(Use same OTP_PROVIDER / PROVIDER_MODE as EVOLUXE in backend .env.)");
}

main()
  .then(() => disconnectDatabase())
  .catch(async (error) => {
    console.error(error.message ?? error);
    await disconnectDatabase().catch(() => {});
    process.exit(1);
  });