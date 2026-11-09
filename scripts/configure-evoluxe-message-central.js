/**
 * Store Message Central VerifyNow credentials on tenant EVOLUXE (MongoDB).
 *
 * Message Central often ships only customerId + authToken (JWT), not password key + email.
 *
 * Usage (set in .env, do not commit):
 *   MESSAGE_CENTRAL_CUSTOMER_ID=C-...
 *   MESSAGE_CENTRAL_AUTH_TOKEN=eyJ...
 *   OTP_PROVIDER=message_central
 *   PROVIDER_MODE=live
 *
 * Optional:
 *   MESSAGE_CENTRAL_VERIFY_TEST_MOBILE=+919876543210  — live send during configure
 *
 *   npm run configure:evoluxe-message-central
 */
import process from "node:process";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { sealIntegrationSecret } from "../src/lib/crypto.js";
import {
  getMessageCentralAuthToken,
  invalidateMessageCentralAuthCache,
  resolveMessageCentralBucket,
} from "../src/lib/message-central-credentials.js";
import { sendMessageCentralOtp } from "../src/integrations/message-central.client.js";
import { Tenant } from "../src/models/index.js";

const TENANT_CODE = "EVOLUXE";

function requiredEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing ${name} in environment (.env).`);
  return v;
}

async function main() {
  const customerId = requiredEnv("MESSAGE_CENTRAL_CUSTOMER_ID");
  const authToken = requiredEnv("MESSAGE_CENTRAL_AUTH_TOKEN");
  const testMobile = process.env.MESSAGE_CENTRAL_VERIFY_TEST_MOBILE?.trim();

  await connectDatabase();
  const tenant = await Tenant.findOne({ code: TENANT_CODE }).select("+integrationSecrets");
  if (!tenant) {
    throw new Error(`Tenant ${TENANT_CODE} not found. Seed EVOLUXE first.`);
  }

  const bucket = {
    provider: "MESSAGE_CENTRAL",
    customerId,
    authTokenSealed: sealIntegrationSecret(authToken),
    keySealed: undefined,
    email: process.env.MESSAGE_CENTRAL_EMAIL?.trim() || tenant.integrationSecrets?.messageCentral?.email || null,
    countryCode: "91",
    flowType: "SMS",
    otpLength: Number(process.env.MESSAGE_CENTRAL_OTP_LENGTH ?? 6),
    credentialVersion: Number(tenant.integrationSecrets?.messageCentral?.credentialVersion ?? 0) + 1,
    verificationStatus: "NOT_VERIFIED",
    verifiedAt: undefined,
  };

  tenant.integrationSecrets = tenant.integrationSecrets ?? {};
  tenant.integrationSecrets.messageCentral = bucket;
  tenant.version = Number(tenant.version ?? 0) + 1;
  await tenant.save();
  invalidateMessageCentralAuthCache(tenant._id);

  const credentials = resolveMessageCentralBucket(tenant.toObject());
  const token = await getMessageCentralAuthToken(credentials, tenant._id);
  console.log(`Auth token resolved (${token.slice(0, 12)}…).`);

  if (testMobile) {
    const sent = await sendMessageCentralOtp({
      authToken: token,
      mobile: testMobile,
      countryCode: credentials.countryCode,
      flowType: credentials.flowType,
      otpLength: credentials.otpLength,
    });
    console.log(`Test OTP queued. verificationId=${sent.verificationId}`);
  }

  tenant.integrationSecrets.messageCentral.verifiedAt = new Date();
  tenant.integrationSecrets.messageCentral.verificationStatus = "VERIFIED";
  await tenant.save();

  console.log(`\n${TENANT_CODE} Message Central configured (auth token mode, verified).`);
  console.log("Ensure OTP_PROVIDER=message_central and PROVIDER_MODE=live in .env, then restart the API.");
  console.log("Customer portal: /customer/evoluxe/login");
}

main()
  .catch((err) => {
    console.error(err.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
