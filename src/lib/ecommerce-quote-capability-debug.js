import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { presentEcommerceAccessState } from "./ecommerce-access.js";
import { allowTestEcommercePayments, isEcommercePaymentsTestHarnessEnabled } from "./ecommerce-test-harness.js";
import { isPlanFeatureEnabled } from "./feature-entitlements.js";
import { subscriptionCatalogPlanFromTenant } from "./subscription-plan-for-tenant.js";

export function redactMongoTarget(uri) {
  const raw = String(uri ?? "").trim();
  if (!raw) return { host: "(unset)", dbName: "(unset)" };
  try {
    const normalized = raw.replace(/^mongodb(\+srv)?:\/\//, "https://");
    const u = new URL(normalized);
    return {
      host: u.hostname || "(unknown)",
      dbName: u.pathname.replace(/^\//, "").split("?")[0] || "(default)",
    };
  } catch {
    return { host: "(invalid-uri)", dbName: "(invalid-uri)" };
  }
}

function shouldLogQuoteCapabilityDebug() {
  return env.NODE_ENV !== "production";
}

/** Safe structured log for GET /app/shop/quotes/:id capability investigation (non-production only). */
export function logQuoteCapabilityDebug(req, { quoteRow, tenant, capability }) {
  if (!shouldLogQuoteCapabilityDebug()) return;
  const catalogPlan = subscriptionCatalogPlanFromTenant(tenant);
  const access = presentEcommerceAccessState(tenant);
  const clientApiBase =
    String(req.headers["x-swarna-client-api-base"] ?? "").trim()
    || String(req.headers["x-client-api-base"] ?? "").trim()
    || null;
  logger.info(
    {
      route: "GET /app/shop/quotes/:id",
      clientApiBase,
      requestOrigin: req.headers.origin ?? null,
      backend: {
        NODE_ENV: env.NODE_ENV,
        mongo: redactMongoTarget(env.MONGODB_URI),
        ECOMMERCE_PAYMENTS_TEST_HARNESS: env.ECOMMERCE_PAYMENTS_TEST_HARNESS,
        ECOMMERCE_PAYMENTS_ROLLOUT_ENABLED: env.ECOMMERCE_PAYMENTS_ROLLOUT_ENABLED,
        PROVIDER_MODE: env.PROVIDER_MODE,
      },
      auth: {
        tenantId: req.auth?.tenantId ?? null,
        customerId: req.auth?.id ?? null,
      },
      quote: {
        id: quoteRow?._id ?? null,
        tenantId: quoteRow?.tenantId ?? null,
      },
      tenant: {
        id: tenant?._id ?? null,
        code: tenant?.code ?? null,
        operationsEcommerceEnabled: tenant?.operations?.ecommerceEnabled === true,
        subscriptionTier: tenant?.subscription?.tier ?? null,
        planId: tenant?.subscription?.planId ?? null,
        planFeaturesSnapshot: tenant?.subscription?.planFeaturesSnapshot ?? null,
        attachedCatalogPlan: catalogPlan
          ? {
              id: catalogPlan._id,
              tier: catalogPlan.tier,
              ecommerce: catalogPlan.features?.ecommerce === true,
              ecommercePayments: catalogPlan.features?.ecommercePayments === true,
            }
          : null,
        effectiveAccess: access,
        planEcommerce: isPlanFeatureEnabled(tenant, "ecommerce"),
        planEcommercePayments: isPlanFeatureEnabled(tenant, "ecommercePayments"),
      },
      harness: {
        active: isEcommercePaymentsTestHarnessEnabled(),
        allowTestEcommercePayments: allowTestEcommercePayments(),
      },
      capability: {
        checkoutTaxReady: capability.checkoutTaxReady,
        paymentAllowed: capability.paymentAllowed,
        storeOperational: capability.storeOperational,
        blockerCodes: (capability.blockers ?? []).map((b) => b.code),
      },
    },
    "Ecommerce quote capability debug",
  );
}
