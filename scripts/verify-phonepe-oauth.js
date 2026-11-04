/**
 * Prove PhonePe sandbox OAuth works before live checkout.
 * Usage:
 *   node --env-file=.env scripts/verify-phonepe-oauth.js
 *   PHONEPE_BOOTSTRAP_CLIENT_ID=... PHONEPE_BOOTSTRAP_CLIENT_SECRET=... node --env-file=.env scripts/verify-phonepe-oauth.js
 */
import process from "node:process";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { resolvePhonePeCredentials } from "../src/integrations/phonepe.provider.js";
import { Tenant } from "../src/models/index.js";

const SANDBOX_TOKEN_URL = "https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token";

async function fetchOAuthToken({ clientId, clientSecret, clientVersion }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    client_version: String(clientVersion ?? 1),
    grant_type: "client_credentials",
  });
  const response = await fetch(SANDBOX_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const text = await response.text();
  return { status: response.status, text };
}

async function main() {
  const fromEnv = {
    clientId: process.env.PHONEPE_BOOTSTRAP_CLIENT_ID?.trim(),
    clientSecret: process.env.PHONEPE_BOOTSTRAP_CLIENT_SECRET?.trim(),
    clientVersion: Number(process.env.PHONEPE_BOOTSTRAP_CLIENT_VERSION ?? 1),
  };

  let credentials = fromEnv.clientId && fromEnv.clientSecret ? fromEnv : null;
  if (!credentials) {
    await connectDatabase();
    const tenant = await Tenant.findOne({ code: "EVOLUXE" }).select("+integrationSecrets").lean();
    credentials = resolvePhonePeCredentials(tenant);
    await disconnectDatabase();
  }

  if (!credentials?.clientId || !credentials?.clientSecret) {
    console.error("No credentials. Set PHONEPE_BOOTSTRAP_CLIENT_ID/SECRET or configure EVOLUXE tenant.");
    process.exit(1);
  }

  console.log("PhonePe sandbox OAuth probe");
  console.log(`  URL: ${SANDBOX_TOKEN_URL}`);
  console.log(`  client_id: ${credentials.clientId}`);
  console.log(`  client_version: ${credentials.clientVersion ?? 1}`);

  const { status, text } = await fetchOAuthToken(credentials);
  if (status === 200) {
    const json = JSON.parse(text);
    console.log("\nSUCCESS — OAuth token received.");
    console.log(`  token_type: ${json.token_type}`);
    console.log(`  expires_at: ${json.expires_at}`);
    console.log("\nNext: npm run configure:evoluxe-phonepe");
    console.log("Restart API (PROVIDER_MODE=live, DIGITAL_METALS_CHECKOUT_MODE=live) and retry payment.");
    return;
  }

  console.error(`\nFAILED — HTTP ${status}`);
  console.error(text);
  console.error(`
PhonePe rejected these credentials (401 = invalid client_id/secret/version or PG not enabled on merchant).

Fix (required for real PhonePe UI):
1. PhonePe Business Dashboard → Developer Settings → API Keys → Test credentials
2. Click Generate / Regenerate (old keys stop working)
3. Copy Client Id, Client Secret, Client Version with no spaces
4. Update .env PHONEPE_BOOTSTRAP_CLIENT_ID and PHONEPE_BOOTSTRAP_CLIENT_SECRET
5. Run: node --env-file=.env scripts/verify-phonepe-oauth.js  (must print SUCCESS)
6. Run: npm run configure:evoluxe-phonepe
7. Restart: npm run dev:api

Postman/curl (same test):
curl -X POST '${SANDBOX_TOKEN_URL}' \\
  -H 'Content-Type: application/x-www-form-urlencoded' \\
  --data-urlencode 'client_id=YOUR_ID' \\
  --data-urlencode 'client_version=1' \\
  --data-urlencode 'client_secret=YOUR_SECRET' \\
  --data-urlencode 'grant_type=client_credentials'
`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
