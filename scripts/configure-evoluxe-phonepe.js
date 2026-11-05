/**
 * One-time local bootstrap: PhonePe sandbox credentials on tenant EVOLUXE (MongoDB).
 * Does not store secrets in .env — only updates tenant.integrationSecrets.phonepe.
 *
 * Usage:
 *   npm run configure:evoluxe-phonepe
 *
 * Optional overrides (e.g. in .env, not committed):
 *   PHONEPE_BOOTSTRAP_CLIENT_ID
 *   PHONEPE_BOOTSTRAP_CLIENT_SECRET
 *   PHONEPE_BOOTSTRAP_CLIENT_VERSION  (default 1)
 *   PHONEPE_BOOTSTRAP_WEBHOOK_USERNAME
 *   PHONEPE_BOOTSTRAP_WEBHOOK_PASSWORD
 */
import process from "node:process";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { seal } from "../src/lib/crypto.js";
import { phonePeProvider, resolvePhonePeCredentials } from "../src/integrations/phonepe.provider.js";
import { invalidatePhonePeClientCache } from "../src/integrations/phonepe.provider.js";
import { Tenant } from "../src/models/index.js";

const TENANT_CODE = "EVOLUXE";

/** Set via PHONEPE_BOOTSTRAP_* in `.env` (never commit secrets). */
const DEFAULTS = {
  clientId: "",
  clientSecret: "",
  clientVersion: 1,
  webhookUsername: "evoluxe_sandbox_webhook",
  webhookPassword: "EvoluxeSandboxWebhook2026!",
  environment: "SANDBOX",
};

function bootstrapValue(key, envKey) {
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULTS[key];
}

async function main() {
  if (process.env.PROVIDER_MODE === "mock") {
    console.warn("Warning: PROVIDER_MODE=mock — set PROVIDER_MODE=live in .env to hit PhonePe sandbox.");
  }

  await connectDatabase();
  const tenant = await Tenant.findOne({ code: TENANT_CODE }).select("+integrationSecrets");
  if (!tenant) {
    throw new Error(`Tenant ${TENANT_CODE} not found. Seed EVOLUXE first.`);
  }

  const clientId = bootstrapValue("clientId", "PHONEPE_BOOTSTRAP_CLIENT_ID");
  const clientSecret = bootstrapValue("clientSecret", "PHONEPE_BOOTSTRAP_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error(
      "Set PHONEPE_BOOTSTRAP_CLIENT_ID and PHONEPE_BOOTSTRAP_CLIENT_SECRET in .env (PhonePe Developer Settings → Test credentials).",
    );
  }
  const clientVersion = Number(
    process.env.PHONEPE_BOOTSTRAP_CLIENT_VERSION ?? DEFAULTS.clientVersion,
  );
  const webhookUsername = bootstrapValue("webhookUsername", "PHONEPE_BOOTSTRAP_WEBHOOK_USERNAME");
  const webhookPassword = bootstrapValue("webhookPassword", "PHONEPE_BOOTSTRAP_WEBHOOK_PASSWORD");
  const environment = process.env.PHONEPE_BOOTSTRAP_ENVIRONMENT?.trim() ?? DEFAULTS.environment;

  tenant.integrationSecrets ??= {};
  tenant.integrationSecrets.phonepe = {
    provider: "PHONEPE",
    clientId,
    clientSecret: seal(clientSecret),
    clientVersion,
    credentialVersion: Number(tenant.integrationSecrets.phonepe?.credentialVersion ?? 0) + 1,
    webhookUsername,
    webhookPassword: seal(webhookPassword),
    environment,
    verificationStatus: "NOT_VERIFIED",
    verifiedAt: undefined,
  };

  tenant.operations ??= {};
  tenant.operations.customerAppPaymentsEnabled = true;
  tenant.operations.customerAppWriteEnabled = true;
  tenant.operations.ecommerceEnabled = true;
  tenant.operations.ecommercePaymentsRolloutEnabled = true;
  tenant.operations.digitalMetalsEnabled = true;

  tenant.branding ??= {};
  if (!tenant.branding.websiteUrl) {
    tenant.branding.websiteUrl = "http://localhost:3000";
  }

  tenant.markModified("integrationSecrets");
  tenant.markModified("operations");
  tenant.markModified("branding");
  await tenant.save();
  invalidatePhonePeClientCache(tenant._id);

  const credentials = resolvePhonePeCredentials(tenant.toObject());
  console.log(`Verifying PhonePe credentials for ${TENANT_CODE} (${tenant._id})…`);
  const skipVerify =
    process.env.PHONEPE_BOOTSTRAP_SKIP_VERIFY === "true"
    || process.env.LOCAL_PHONEPE_SKIP_VERIFY === "true";
  if (skipVerify) {
    console.warn("Skipping live PhonePe verify (PHONEPE_BOOTSTRAP_SKIP_VERIFY / LOCAL_PHONEPE_SKIP_VERIFY).");
  } else {
    try {
      await phonePeProvider.verifyCredentials(credentials, tenant._id);
    } catch (error) {
      console.error("PhonePe verify failed:", error?.message ?? error);
      console.error("Run: npm run verify:phonepe-oauth — must succeed before live checkout works.");
      throw error;
    }
  }

  tenant.integrationSecrets.phonepe.verifiedAt = new Date();
  tenant.integrationSecrets.phonepe.verificationStatus = "VERIFIED";
  tenant.markModified("integrationSecrets");
  await tenant.save();

  console.log("\nEVOLUXE PhonePe sandbox configured.");
  console.log(`  Tenant id: ${tenant._id}`);
  console.log(`  Client id: ${clientId.slice(0, 8)}…`);
  console.log(`  Environment: ${environment}`);
  console.log(`  Webhook URL (register in PhonePe when using tunnels):`);
  console.log(
    `    ${process.env.PUBLIC_BASE_URL ?? "http://localhost:4050"}/api/v1/webhooks/phonepe/${tenant._id}`,
  );
  console.log("\nCustomer portal: /customer/evoluxe/login (OTP 123456 in mock OTP mode)");
  console.log("Ensure backend PROVIDER_MODE=live, PHONEPE_ENV=SANDBOX, frontend NEXT_PUBLIC_USE_MOCKS=false");
}

main()
  .then(() => disconnectDatabase())
  .catch(async (error) => {
    console.error(error);
    await disconnectDatabase().catch(() => {});
    process.exit(1);
  });
