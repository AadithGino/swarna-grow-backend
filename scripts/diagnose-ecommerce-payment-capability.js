/**
 * Print deriveEcommerceCheckoutCapability for tenant codes (read-only).
 * Uses attachSubscriptionCatalogPlan — same resolution as customer GET /app/shop/quotes/:id after the checkout-tenant fix.
 * Usage: node --env-file=.env scripts/diagnose-ecommerce-payment-capability.js MEHER KAIRALI
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { deriveEcommerceCheckoutCapability } from "../src/lib/ecommerce-checkout-capability.js";
import { allowTestEcommercePayments, isEcommercePaymentsTestHarnessEnabled } from "../src/lib/ecommerce-test-harness.js";
import { attachSubscriptionCatalogPlan } from "../src/lib/subscription-plan-for-tenant.js";
import { EcommerceFulfilmentSettings, EcommerceTaxSettings, Tenant } from "../src/models/index.js";
import { resolvePhonePeCredentials } from "../src/integrations/phonepe.provider.js";
import { customerAppPaymentsEnabled } from "../src/lib/customer-app-access.js";
import { isPlanFeatureEnabled } from "../src/lib/feature-entitlements.js";

function gatewayConfigured(tenant) {
  try {
    const credentials = resolvePhonePeCredentials(tenant);
    return Boolean(credentials?.clientId && credentials?.clientSecret);
  } catch {
    return false;
  }
}

async function diagnoseCode(code) {
  const tenant = await Tenant.findOne({ code: String(code).trim().toUpperCase() })
    .select("+integrationSecrets")
    .lean();
  if (!tenant) {
    return { tenantCode: code, error: "TENANT_NOT_FOUND" };
  }
  const withCatalog = await attachSubscriptionCatalogPlan(tenant);
  const taxSettings = await EcommerceTaxSettings.findOne({ tenantId: tenant._id }).lean();
  const fulfilment = await EcommerceFulfilmentSettings.findOne({ tenantId: tenant._id }).lean();
  const capability = deriveEcommerceCheckoutCapability({
    taxSettings,
    fulfilmentSettingsRow: fulfilment ?? {},
    tenant: withCatalog,
  });
  return {
    tenantCode: withCatalog.code,
    tenantName: withCatalog.name,
    tenantId: withCatalog._id,
    environment: {
      NODE_ENV: process.env.NODE_ENV ?? env.NODE_ENV,
      ECOMMERCE_PAYMENTS_ROLLOUT_ENABLED: env.ECOMMERCE_PAYMENTS_ROLLOUT_ENABLED,
      ECOMMERCE_PAYMENTS_TEST_HARNESS: process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS ?? null,
      testHarnessActive: isEcommercePaymentsTestHarnessEnabled(),
      testHarnessWouldAllowPayment: allowTestEcommercePayments(),
    },
    gates: {
      planEcommerce: isPlanFeatureEnabled(withCatalog, "ecommerce"),
      planEcommercePayments: isPlanFeatureEnabled(withCatalog, "ecommercePayments"),
      customerAppPaymentsEnabled: customerAppPaymentsEnabled(withCatalog),
      phonePeConfigured: gatewayConfigured(withCatalog),
      platformRollout: env.ECOMMERCE_PAYMENTS_ROLLOUT_ENABLED === true,
      tenantRollout: withCatalog?.operations?.ecommercePaymentsRolloutEnabled === true,
      storeEcommerceEnabled: withCatalog?.operations?.ecommerceEnabled === true,
    },
    capability: {
      checkoutTaxReady: capability.checkoutTaxReady,
      paymentAllowed: capability.paymentAllowed,
      checkoutUsable: capability.checkoutUsable,
      taxPresentation: capability.taxPresentation,
      blockers: capability.blockers,
    },
  };
}

async function main() {
  const codes = process.argv.slice(2);
  if (!codes.length) {
    process.stderr.write("Usage: node --env-file=.env scripts/diagnose-ecommerce-payment-capability.js KAIRALI\n");
    process.exit(1);
  }
  await connectDatabase();
  try {
    for (const code of codes) {
      process.stdout.write(`${JSON.stringify(await diagnoseCode(code), null, 2)}\n`);
    }
  } finally {
    await disconnectDatabase();
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});
